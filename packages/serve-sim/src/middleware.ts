import { readdirSync, readFileSync, existsSync, unlinkSync, watch, type FSWatcher } from "fs";
import { execSync, spawn, exec, execFile, type ChildProcess, type ExecException } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { createServer as createNetServer } from "net";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { Socket } from "net";
// `ws` (kept external in the build) supplies a WebSocket *client* for the
// helper/devtools proxy. Node only exposes a global `WebSocket` on newer LTS
// lines, and `serve-sim/middleware` is embedded in third-party dev servers, so
// importing the dependency keeps the proxy working regardless of runtime.
import { WebSocket } from "ws";
import { createAxStreamerCache } from "./ax";
import { getDeviceSession, closeDeviceSession, type HidSocket } from "./device-session";
import {
  eventLogEventForCommand,
  readEventLog,
  recordEventLogEvent,
  subscribeEventLog,
} from "./event-log";
import { axFrontmostAsync } from "./native";
import { inProcessServeSimState, writeServeSimState, type ServeSimDeviceState } from "./state";
import { debugMw } from "./debug";
import {
  resolveDevicePlaceholderAsset,
  resolveDeviceKitChrome,
  serveDeviceKitChromeAsset,
  serveDevicePlaceholderAsset,
} from "./devicekit-chrome";
import { createExecUpgradeHandler, type UiRequestHandler } from "./exec-ws";
import { UI_OPTIONS, getUiStatus, normalizeUiValue, setUiOption } from "./ui-settings";

type SimReq = IncomingMessage;
type SimRes = ServerResponse;
type SimNext = (err?: unknown) => Promise<void>;
export type SimMiddleware = {
  (req: SimReq, res: SimRes, next?: SimNext): Promise<void>;
  handleUpgrade(req: SimReq, socket: Socket, head: Buffer): void;
};

// Injected at build time as a base64-encoded string via `define`
declare const __PREVIEW_HTML_B64__: string;
const STATE_DIR = join(tmpdir(), "serve-sim");
// Last logged result of a GET /api selection, used to suppress the
// once-every-poll duplicate debugMw lines (the UI polls /api every ~2s).
let lastApiLogKey: string | undefined;
const DEVTOOLS_FRONTEND_REV = "854a02be78c7ffea104cb523636efa991bef5c5b";
const INSPECT_WEBKIT_START_PORT = 9222;

type WebKitBridgeTarget = {
  id: string;
  title: string;
  url: string;
  type: string;
  appName?: string;
  bundleId?: string;
  /** udid of the simulator hosting the target, when known. */
  udid?: string;
  inUseByOtherInspector?: boolean;
};

export type WebKitBridge = {
  port: number;
  cdpUrl: string;
  listTargets(): Promise<WebKitBridgeTarget[]>;
  highlightTarget?(targetId: string, on: boolean): Promise<void>;
  releaseHighlight?(targetId?: string): void;
};

type InspectWebKitBridgeTarget = {
  targetId: string;
  title?: string;
  appName?: string;
  url?: string;
  type?: string;
  bundleId?: string;
  inUseByOtherInspector?: boolean;
  source?: { kind?: string; id?: string };
};

type CdpHttpListEntry = {
  id: string;
  title: string;
  url: string;
  type: string;
  description?: string;
};

type CdpHttpVersion = { Browser?: string };

type SimctlBootedList = {
  devices: Record<string, Array<{ udid: string; state: string }>>;
};

type SimctlAllList = {
  devices: Record<string, Array<Omit<SimctlDevice, "runtime">>>;
};

type ShutdownRequestBody = { udid?: string };
type StartRequestBody = { udid?: string };
type ReleaseRequestBody = { targetId?: string };
type HighlightRequestBody = { targetId?: string; on?: boolean };
type ExecRequestBody = { command?: string };

/** Re-exported alias for the canonical device-state record in `./state`. */
export type ServeSimState = ServeSimDeviceState;

const axStreamerCache = createAxStreamerCache();

// Hard cap on the SSE line-assembly buffer for child-process stdout.
// A malformed log entry without a newline can't grow this beyond 1 MB;
// the partial line is dropped rather than retained indefinitely.
const SSE_LINE_BUFFER_LIMIT = 1024 * 1024;
let inspectWebKitBridge: Promise<WebKitBridge> | null = null;

function eventLogLimit(rawUrl: string): number | undefined {
  const value = new URL(rawUrl, "http://x").searchParams.get("limit");
  if (!value) return undefined;
  const limit = Number(value);
  return Number.isFinite(limit) ? limit : undefined;
}

function eventLogSinceId(rawUrl: string): number | undefined {
  const value = new URL(rawUrl, "http://x").searchParams.get("since");
  if (!value) return undefined;
  const since = Number(value);
  return Number.isFinite(since) ? since : undefined;
}

function recordCommandEvent(command: string, result: { exitCode?: number }): void {
  try {
    const event = eventLogEventForCommand(command, result);
    if (event) recordEventLogEvent(event);
  } catch {
    // Event-log recording is diagnostic; it must never break the exec path.
  }
}

// Known bundle IDs that are always React Native shells (used as a fallback
// before the app-container path resolves, since simctl can lag after launch).
const RN_BUNDLE_IDS = new Set<string>([
  "host.exp.Exponent",       // Expo Go (App Store)
  "dev.expo.Exponent",       // Expo Go dev builds
]);

const RN_MARKERS = [
  "Frameworks/React.framework",
  "Frameworks/hermes.framework",
  "Frameworks/Hermes.framework",
  "Frameworks/ExpoModulesCore.framework",
  "main.jsbundle",
];

// Processes that SpringBoard logs as "Foreground" but are not the visible
// user-facing app — widgets, extensions, background services. Emitting
// these to the client causes the app indicator to flicker as the user
// actually-foreground app switches mid-launch.
const NON_UI_BUNDLE_RE = /(WidgetRenderer|ExtensionHost|\.extension(\.|$)|Service|PlaceholderApp|InCallService|CallUI|InCallUI|com\.apple\.Preferences\.Cellular|com\.apple\.purplebuddy|com\.apple\.chrono|com\.apple\.shuttle|com\.apple\.usernotificationsui)/i;

function isUserFacingBundle(bundleId: string): boolean {
  return !NON_UI_BUNDLE_RE.test(bundleId);
}

function isSimulatorUdid(value: string): boolean {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(value);
}

/** What to do with a persisted device state when reaping during a grid poll. */
type StaleStateAction = "keep" | "recycle-self" | "recycle-helper";

/**
 * Decide how to reap a state record whose backing simulator may have been shut
 * down. A booted device (or a non-simulator/unknown `booted` set) is kept.
 *
 * The critical distinction is `recycle-self` vs `recycle-helper`: in in-process
 * mode `inProcessServeSimState` records the *server's own* pid, so SIGTERMing it
 * (as we do for a separate stale helper) would kill the whole server — and
 * index.ts converts SIGTERM into `process.exit`. When the dead device is ours,
 * we stop just that device's capture session instead of signalling the pid.
 */
function classifyStaleState(
  state: { pid: number; device: string },
  booted: Set<string> | null,
  selfPid: number,
): StaleStateAction {
  if (booted && isSimulatorUdid(state.device) && !booted.has(state.device)) {
    return state.pid === selfPid ? "recycle-self" : "recycle-helper";
  }
  return "keep";
}

export function parseForegroundAppLogMessage(message: string): { bundleId: string; pid: number } | null {
  // e.g. "[app<com.apple.mobilesafari>:43117] Setting process visibility to: Foreground"
  const match = /\[app<([^>]+)>:(\d+)\] Setting process visibility to: Foreground/.exec(message);
  if (!match) return null;
  return { bundleId: match[1]!, pid: parseInt(match[2]!, 10) };
}

function detectReactNative(udid: string, bundleId: string): Promise<boolean> {
  if (RN_BUNDLE_IDS.has(bundleId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile("xcrun", ["simctl", "get_app_container", udid, bundleId, "app"],
      { timeout: 2000 },
      (err, stdout) => {
        if (err) return resolve(false);
        const appPath = stdout.trim();
        if (!appPath) return resolve(false);
        for (const marker of RN_MARKERS) {
          if (existsSync(join(appPath, marker))) return resolve(true);
        }
        resolve(false);
      });
  });
}

type InstalledApp = {
  CFBundleDisplayName?: string;
  CFBundleExecutable?: string;
  CFBundleIdentifier?: string;
  CFBundleName?: string;
};

function normalizeAppName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function matchInstalledAppByDisplayName(
  apps: Record<string, InstalledApp>,
  displayName: string,
): string | null {
  const wanted = normalizeAppName(displayName);
  if (!wanted) return null;

  for (const [bundleId, app] of Object.entries(apps)) {
    const names = [
      app.CFBundleDisplayName,
      app.CFBundleName,
      app.CFBundleExecutable,
    ].filter((value): value is string => typeof value === "string");
    if (names.some((name) => normalizeAppName(name) === wanted)) {
      return app.CFBundleIdentifier || bundleId;
    }
  }
  return null;
}

// Cache simctl's booted-device set briefly so per-request cost stays bounded.
// The middleware runs inside the user's dev server (Metro etc.) and
// readServeSimStates() is called on every /api and every page load.
let bootedSnapshot: { at: number; booted: Set<string> | null } = { at: 0, booted: null };
async function getBootedUdids(): Promise<Set<string> | null> {
  const now = Date.now();
  if (bootedSnapshot.booted && now - bootedSnapshot.at < 1500) {
    return bootedSnapshot.booted;
  }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "xcrun",
        ["simctl", "list", "devices", "booted", "-j"],
        { encoding: "utf-8", timeout: 3_000 },
        (err, stdout) => {
          if (err) {
            reject(err);
          } else {
            resolve(stdout);
          }
        },
      );
    });
    const data = JSON.parse(stdout) as SimctlBootedList;
    const booted = new Set<string>();
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.state === "Booted") booted.add(device.udid);
      }
    }
    bootedSnapshot = { at: now, booted };
    return booted;
  } catch {
    return null;
  }
}

// The device the user most recently opened in Simulator.app, regardless of
// which tool launched it. Simulator.app persists this as CurrentDeviceUDID, so
// it's the best signal for "the device this user actually cares about" — we
// surface it near the top of the grid the way Xcode's Devices window does.
let preferredSnapshot: { at: number; udid: string | null } = { at: 0, udid: null };
function getPreferredDeviceUdid(): string | null {
  const now = Date.now();
  if (now - preferredSnapshot.at < 1500) return preferredSnapshot.udid;
  let udid: string | null = null;
  try {
    udid =
      execSync("defaults read com.apple.iphonesimulator CurrentDeviceUDID", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
      }).trim() || null;
  } catch {
    udid = null;
  }
  preferredSnapshot = { at: now, udid };
  return udid;
}

export async function readServeSimStates(): Promise<ServeSimState[]> {
  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter(
      (f) => f.startsWith("server-") && f.endsWith(".json"),
    );
  } catch {
    return [];
  }
  const booted = await getBootedUdids();
  const states: ServeSimState[] = [];
  for (const f of files) {
    const path = join(STATE_DIR, f);
    try {
      const state: ServeSimState = JSON.parse(readFileSync(path, "utf-8"));
      try {
        process.kill(state.pid, 0);
      } catch {
        debugMw("helper pid=%d gone, removing %s", state.pid, path);
        try { unlinkSync(path); } catch {}
        continue;
      }
      // Helper alive but its simulator was shut down — the MJPEG stream
      // would accept connections yet never produce frames, leaving the
      // preview stuck on "Connecting...". Recycle the stale state so the
      // caller can spawn a fresh helper bound to whatever is booted.
      const action = classifyStaleState(state, booted, process.pid);
      if (action !== "keep") {
        if (action === "recycle-self") {
          // This device is streamed in-process by *us* (the close button just
          // shut its sim down). SIGTERMing state.pid would kill the whole
          // server; instead stop just this device's capture session.
          debugMw(
            "closing in-process session for shut-down device %s (own pid %d)",
            state.device,
            state.pid,
          );
          closeDeviceSession(state.device);
        } else {
          debugMw(
            "recycling stale helper pid=%d (device %s no longer booted)",
            state.pid,
            state.device,
          );
          try { process.kill(state.pid, "SIGTERM"); } catch {}
        }
        try { unlinkSync(path); } catch {}
        continue;
      }
      states.push(state);
    } catch {}
  }
  return states;
}

export function selectServeSimState(
  states: ServeSimState[],
  device?: string | null,
): ServeSimState | null {
  if (device) {
    return states.find((state) => state.device === device) ?? null;
  }
  return states[0] ?? null;
}

function queryDevice(rawUrl: string): string | null {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return null;
  return new URLSearchParams(rawUrl.slice(qIndex + 1)).get("device");
}

/**
 * Parse `/grid/api` pagination params. `limit` absent → return the whole list
 * (back-compat for embedded mounts that expect every device in one response).
 * The full DeviceKit `chrome` descriptor is only resolved for the returned
 * page, so a remote viewer over a tunnel fetches a small first page instead of
 * the whole simulator catalog (~150KB) up front.
 */
export function parseGridPaging(rawUrl: string): { limit: number | null; offset: number } {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return { limit: null, offset: 0 };
  const params = new URLSearchParams(rawUrl.slice(qIndex + 1));
  const rawLimit = params.get("limit");
  const rawOffset = params.get("offset");
  // Clamp to sane bounds; ignore non-numeric/negative input rather than erroring.
  const limit =
    rawLimit == null || !/^\d+$/.test(rawLimit)
      ? null
      : Math.min(Math.max(Number(rawLimit), 1), 1000);
  const offset =
    rawOffset == null || !/^\d+$/.test(rawOffset) ? 0 : Math.max(Number(rawOffset), 0);
  return { limit, offset };
}

function hostForRequest(req: SimReq): string | undefined {
  const host = req.headers?.host;
  if (host) return host;
  const port = req.socket.localPort;
  return port ? `localhost:${port}` : undefined;
}

function endpoint(base: string, path: string, device: string): string {
  const value = `${base}${path}`;
  return `${value}?device=${encodeURIComponent(device)}`;
}

/**
 * Rewrite the helper URLs in a state for the requesting browser.
 *
 * When `proxy` is set (standalone `serve-sim`, which owns its server and wires
 * WebSocket upgrades), the URLs point at the preview's same-origin `/helper`
 * proxy so remote viewers only need the one preview port. When it's off — the
 * default for embedded `app.use(simMiddleware(...))` mounts, where the host's
 * server doesn't forward `upgrade` events to `handleUpgrade` — the helper's
 * loopback URLs are emitted directly (with `127.0.0.1` swapped for the request
 * hostname so LAN/tunnel viewers can still reach the separate helper port).
 */
export function rewriteStateForRequestHost(
  state: ServeSimState,
  hostHeader: string | undefined,
  base = "",
  protocol: "http" | "https" = "http",
  proxy = false,
): ServeSimState {
  if (!hostHeader) {
    return state;
  }
  if (!proxy) {
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      return state;
    }
    // `URL.hostname` keeps brackets around IPv6 literals, so the IPv6 loopback
    // comparison is against the bracketed form rather than `::1`.
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
      return state;
    }
    const rewrite = (s: string) => s.replace("127.0.0.1", hostname);
    return {
      ...state,
      url: rewrite(state.url),
      streamUrl: rewrite(state.streamUrl),
      wsUrl: rewrite(state.wsUrl),
    };
  }
  const normalizedBase = base === "/" ? "" : base.replace(/\/+$/, "");
  const helperBase = `${normalizedBase}/helper`;
  const devicePath = `${helperBase}/${encodeURIComponent(state.device)}`;
  // Match the request's scheme so an HTTPS-served preview doesn't hand the
  // browser `http`/`ws` helper URLs (blocked as mixed content). Behind a proxy
  // the original scheme arrives via `x-forwarded-proto`.
  const origin = `${protocol}://${hostHeader}`;
  const wsOrigin = `${protocol === "https" ? "wss" : "ws"}://${hostHeader}`;
  return {
    ...state,
    url: `${origin}${devicePath}`,
    streamUrl: `${origin}${devicePath}/stream.mjpeg`,
    wsUrl: `${wsOrigin}${devicePath}/ws`,
  };
}

function helperProxyPrefix(base: string): string {
  return `${base === "/" ? "" : base}/helper`;
}

function devtoolsProxyPrefix(base: string): string {
  return `${base === "/" ? "" : base}/devtools`;
}

function devtoolsProxyTarget(rawUrl: string, prefix: string): { upstreamPath: string } | null {
  const parsed = new URL(rawUrl, "http://serve-sim.local");
  if (!parsed.pathname.startsWith(`${prefix}/page/`)) {
    return null;
  }
  const suffix = parsed.pathname.slice(prefix.length);
  return { upstreamPath: `/devtools${suffix}${parsed.search}` };
}

function helperProxyTarget(rawUrl: string, prefix: string): { device: string | null; upstreamPath: string } | null {
  const parsed = new URL(rawUrl, "http://serve-sim.local");
  if (parsed.pathname !== prefix && !parsed.pathname.startsWith(`${prefix}/`)) {
    return null;
  }
  const rawSuffix = parsed.pathname.slice(prefix.length);
  const segments = rawSuffix.replace(/^\/+/, "").split("/").filter(Boolean);
  const directHelperEndpoints = new Set([
    "ax",
    "config",
    "foreground",
    "health",
    "stream.avcc",
    "stream.mjpeg",
    "ws",
  ]);
  let device = parsed.searchParams.get("device");
  let upstreamSegments = segments;
  if (segments[0] && !directHelperEndpoints.has(segments[0])) {
    device = decodeURIComponent(segments[0]);
    upstreamSegments = segments.slice(1);
  }
  const suffix = upstreamSegments.length > 0 ? `/${upstreamSegments.join("/")}` : "/";
  parsed.searchParams.delete("device");
  return { device, upstreamPath: `${suffix}${parsed.search}` };
}

const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function websocketFrame(opcode: number, payload: Buffer<ArrayBufferLike>): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

type ParsedWebSocketFrame = {
  opcode: number;
  payload: Buffer<ArrayBufferLike>;
  consumed: number;
};

function parseWebSocketFrame(buffer: Buffer): ParsedWebSocketFrame | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket frame too large");
    }
    length = Number(bigLength);
    offset += 8;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i]! ^ mask[i % 4]!;
    }
  }
  return { opcode, payload, consumed: offset + length };
}

function sendBrowserFrame(socket: Socket, opcode: number, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(websocketFrame(opcode, payload));
}

type PendingWebSocketFrame = {
  opcode: number;
  payload: Buffer<ArrayBufferLike>;
};

function webSocketBinary(payload: Buffer<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(payload.length);
  bytes.set(payload);
  return bytes;
}

/**
 * Complete the server side of a WebSocket upgrade by hand (the `ws` server's
 * handshake doesn't flush under Bun). Writes the 101 response and resumes the
 * socket on success; on a missing key writes 400 and returns false.
 */
function writeWebSocketAccept(req: SimReq, socket: Socket): boolean {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return false;
  }
  const accept = createHash("sha1").update(key + WS_ACCEPT_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    "\r\n",
  );
  socket.resume();
  return true;
}

function bridgeWebSocketFrames(req: SimReq, socket: Socket, head: Buffer, upstreamUrl: string): void {
  if (!writeWebSocketAccept(req, socket)) return;

  const upstream = new WebSocket(upstreamUrl);
  upstream.binaryType = "arraybuffer";
  let upstreamOpen = false;
  let closed = false;
  let pendingToUpstream: PendingWebSocketFrame[] = [];
  let buffered = Buffer.from(head);

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    try { upstream.close(); } catch {}
    try { socket.end(websocketFrame(0x8, Buffer.alloc(0))); } catch {}
    try { socket.destroy(); } catch {}
  };

  const sendToUpstream = (frame: PendingWebSocketFrame) => {
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
      upstream.send(frame.opcode === 0x1 ? frame.payload.toString("utf8") : webSocketBinary(frame.payload));
      return;
    }
    pendingToUpstream.push({ opcode: frame.opcode, payload: Buffer.from(frame.payload) });
  };

  const drainFrames = () => {
    try {
      while (buffered.length > 0) {
        const frame = parseWebSocketFrame(buffered);
        if (!frame) break;
        buffered = buffered.subarray(frame.consumed);
        if (frame.opcode === 0x8) {
          sendBrowserFrame(socket, 0x8, frame.payload);
          closeBoth();
          return;
        }
        if (frame.opcode === 0x9) {
          sendBrowserFrame(socket, 0xA, frame.payload);
          continue;
        }
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          sendToUpstream({ opcode: frame.opcode, payload: frame.payload });
        }
      }
    } catch {
      closeBoth();
    }
  };

  upstream.onopen = () => {
    upstreamOpen = true;
    for (const frame of pendingToUpstream) {
      upstream.send(frame.opcode === 0x1 ? frame.payload.toString("utf8") : webSocketBinary(frame.payload));
    }
    pendingToUpstream = [];
  };
  upstream.onmessage = (event) => {
    const data = event.data;
    const payload = typeof data === "string"
      ? Buffer.from(data)
      : Buffer.from(data as ArrayBuffer);
    sendBrowserFrame(socket, typeof data === "string" ? 0x1 : 0x2, payload);
  };
  upstream.onerror = closeBoth;
  upstream.onclose = closeBoth;

  socket.on("data", (chunk) => {
    if (typeof chunk === "string") chunk = Buffer.from(chunk);
    buffered = Buffer.concat([buffered, chunk]);
    drainFrames();
  });
  socket.on("error", closeBoth);
  socket.on("close", closeBoth);
  drainFrames();
}

/**
 * Serve a helper endpoint from an in-process DeviceSession (NativeCapture +
 * NativeHid). Returns false when no session can serve it (device not booted, or
 * an endpoint this path doesn't own) so the caller can respond 404.
 */
function serveHelperInProcess(req: SimReq, res: SimRes, device: string | null, upstreamPath: string): boolean {
  if (!device) return false;
  let session;
  try {
    session = getDeviceSession(device);
  } catch {
    return false; // not booted / capture unavailable → 404
  }
  switch (upstreamPath.split("?")[0]) {
    case "/stream.mjpeg": session.handleMjpeg(req, res); return true;
    case "/stream.avcc": session.handleAvcc(req, res); return true;
    case "/config": session.handleConfig(req, res); return true;
    case "/health": session.handleHealth(req, res); return true;
    case "/ax": session.handleAx(req, res); return true;
    case "/foreground": session.handleForeground(req, res); return true;
    default: return false;
  }
}

/**
 * Boot a simulator (if needed) and record its in-process state so the grid /
 * preview enumerate it. Replaces spawning `serve-sim --detach <udid>`; the
 * preview server itself serves the device's /helper routes in-process. Resolves
 * to an error string on boot failure, or null on success.
 */
export async function startDeviceInProcess(udid: string, port: number, base: string): Promise<string | null> {
  // `simctl boot` errors when already booted — ignore and let bootstatus confirm.
  await new Promise<void>((resolve) => execFile("xcrun", ["simctl", "boot", udid], () => resolve()));
  const ready = await new Promise<boolean>((resolve) => {
    execFile("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 180_000 }, (err) => resolve(!err));
  });
  if (!ready) {
    // bootstatus can exit non-zero even when the device is actually ready;
    // confirm against the real state before reporting failure.
    const booted = await new Promise<boolean>((resolve) => {
      execFile("xcrun", ["simctl", "list", "devices", "-j"], (err, stdout) => {
        if (err) return resolve(false);
        try {
          const data = JSON.parse(stdout) as { devices: Record<string, Array<{ udid: string; state: string }>> };
          resolve(Object.values(data.devices).flat().some((d) => d.udid === udid && d.state === "Booted"));
        } catch {
          resolve(false);
        }
      });
    });
    if (!booted) return `Device ${udid} failed to reach booted state`;
  }
  writeServeSimState(inProcessServeSimState(udid, port, base));
  return null;
}

/**
 * Adapt a raw upgraded socket into the minimal HidSocket the DeviceSession
 * needs. We do the WebSocket framing by hand (same helpers as the DevTools
 * bridge) rather than via `ws`'s server, whose handshake doesn't flush under
 * Bun — and the production CLI is a bun-compiled binary.
 */
function rawHidSocket(socket: Socket, head: Buffer): HidSocket {
  const messageCbs: Array<(d: Buffer) => void> = [];
  const closeCbs: Array<() => void> = [];
  let buffered = Buffer.from(head);
  let closed = false;

  const fireClose = () => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb();
  };
  const shutdown = () => {
    fireClose();
    try { socket.end(websocketFrame(0x8, Buffer.alloc(0))); } catch {}
    try { socket.destroy(); } catch {}
  };

  const drain = () => {
    for (;;) {
      let frame: ParsedWebSocketFrame | null;
      try {
        frame = parseWebSocketFrame(buffered);
      } catch {
        shutdown();
        return;
      }
      if (!frame) return;
      buffered = buffered.subarray(frame.consumed);
      if (frame.opcode === 0x8) return shutdown();       // close
      if (frame.opcode === 0x9) { sendBrowserFrame(socket, 0xa, frame.payload); continue; } // ping → pong
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        for (const cb of messageCbs) cb(frame.payload);
      }
    }
  };

  socket.on("data", (chunk: Buffer) => { buffered = Buffer.concat([buffered, chunk]); drain(); });
  socket.on("close", fireClose);
  socket.on("error", fireClose);
  if (head.length) drain();

  return {
    send(data: Buffer) { sendBrowserFrame(socket, 0x2, data); },
    on(event: "message" | "close" | "error", cb: (data: Buffer) => void) {
      if (event === "message") messageCbs.push(cb);
      else closeCbs.push(cb as () => void);
    },
    close: shutdown,
  };
}

/** Upgrade an in-process HID `/ws` socket onto a DeviceSession. Returns false when no session can serve it. */
function attachHidInProcess(req: SimReq, socket: Socket, head: Buffer, device: string | null): boolean {
  if (!device) return false;
  let session;
  try {
    session = getDeviceSession(device);
  } catch {
    return false;
  }
  if (!writeWebSocketAccept(req, socket)) return true; // bad request handled
  session.attachHidSocket(rawHidSocket(socket, head));
  return true;
}

export function previewConfigForState(
  state: ServeSimState,
  base: string,
  serveSimBin: string,
  execToken: string,
  codec?: string,
  proxyHelpers = false,
): ServeSimState & {
  basePath: string;
  appStateEndpoint: string;
  eventLogEndpoint: string;
  eventLogEventsEndpoint: string;
  axEndpoint: string;
  devtoolsEndpoint: string;
  serveSimBin: string;
  gridApiEndpoint: string;
  gridStartEndpoint: string;
  gridShutdownEndpoint: string;
  gridMemoryEndpoint: string;
  previewEndpoint: string;
  execToken: string;
  codec?: string;
  proxyHelpers?: boolean;
} {
  const gridApiBase = (base === "" ? "" : base) + "/grid/api";
  return {
    ...state,
    basePath: base,
    appStateEndpoint: endpoint(base, "/appstate", state.device),
    eventLogEndpoint: endpoint(base, "/api/event-log", state.device),
    eventLogEventsEndpoint: endpoint(base, "/api/event-log/events", state.device),
    axEndpoint: endpoint(base, "/ax", state.device),
    devtoolsEndpoint: endpoint(base, "/devtools", state.device),
    serveSimBin,
    gridApiEndpoint: gridApiBase,
    gridStartEndpoint: gridApiBase + "/start",
    gridShutdownEndpoint: gridApiBase + "/shutdown",
    gridMemoryEndpoint: gridApiBase + "/memory",
    previewEndpoint: base === "" ? "/" : base,
    execToken,
    ...(codec ? { codec } : {}),
    ...(proxyHelpers ? { proxyHelpers: true } : {}),
  };
}

async function isLocalPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function existingInspectWebKitBridge(port: number): Promise<WebKitBridge | null> {
  const cdpUrl = `http://127.0.0.1:${port}`;
  try {
    const versionRes = await fetch(`${cdpUrl}/json/version`);
    if (!versionRes.ok) return null;
    const version = await versionRes.json() as CdpHttpVersion;
    if (version.Browser !== "Safari/inspect-webkit") return null;
    return {
      port,
      cdpUrl,
      async listTargets() {
        // Hitting the bridge over HTTP loses the rich fields available to
        // an in-process consumer (appName, inUseByOtherInspector). The id
        // shape `sim:<udid>:<appId>:<pageId>` and the description string
        // `<deviceLabel> (<bundleId>)` are all we have here.
        const listRes = await fetch(`${cdpUrl}/json/list`);
        const targets = await listRes.json() as CdpHttpListEntry[];
        return targets
          .filter((target) => target.id.startsWith("sim:"))
          .map((target) => {
            const idParts = target.id.split(":");
            const udid = idParts[1];
            const bundleId = target.description?.match(/\(([^)]+)\)/)?.[1];
            return {
              id: target.id,
              title: target.title || target.url || "Untitled",
              url: /^https?:/i.test(target.url) ? target.url : "about:blank",
              type: target.type || "page",
              udid,
              bundleId,
            };
          });
      },
    };
  } catch {
    return null;
  }
}

async function ensureInspectWebKitBridge(): Promise<WebKitBridge> {
  if (inspectWebKitBridge) {
    try {
      // Probe so a dead bridge gets retired instead of poisoning every call.
      await (await inspectWebKitBridge).listTargets();
      return inspectWebKitBridge;
    } catch {
      inspectWebKitBridge = null;
    }
  }
  inspectWebKitBridge = (async () => {
    const { startCdpServer } = await import("inspect-webkit");
    for (let port = INSPECT_WEBKIT_START_PORT; port < INSPECT_WEBKIT_START_PORT + 50; port++) {
      if (!(await isLocalPortFree(port))) {
        const existing = await existingInspectWebKitBridge(port);
        if (existing) return existing;
        continue;
      }
      try {
        // Bind explicitly to IPv4 127.0.0.1 so the preview's DevTools
        // websocket proxy has a stable loopback upstream. `localhost` resolves
        // to ::1 first on some setups, which would leave the bridge unreachable.
        const server = await startCdpServer({ host: "127.0.0.1", port }) as Awaited<ReturnType<typeof startCdpServer>> & {
          highlightTarget?(targetId: string, on: boolean): Promise<void>;
          releaseHighlight?(targetId?: string): void;
        };
        return {
          port,
          cdpUrl: `http://127.0.0.1:${port}`,
          async listTargets() {
            return (server.getTargets() as InspectWebKitBridgeTarget[])
              .filter((target) => target.source?.kind === "simulator")
              .map((target) => {
                const url = target.url ?? "";
                return {
                  id: target.targetId,
                  title: target.title || target.appName || url || "Untitled",
                  url: /^https?:/i.test(url) ? url : "about:blank",
                  type: target.type || "page",
                  appName: target.appName,
                  bundleId: target.bundleId,
                  udid: target.source?.id,
                  inUseByOtherInspector: !!target.inUseByOtherInspector,
                };
              });
          },
          highlightTarget: server.highlightTarget?.bind(server),
          releaseHighlight: server.releaseHighlight?.bind(server),
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
          const existing = await existingInspectWebKitBridge(port);
          if (existing) return existing;
          continue;
        }
        throw err;
      }
    }
    throw new Error(`No available inspect-webkit port found in ${INSPECT_WEBKIT_START_PORT}-${INSPECT_WEBKIT_START_PORT + 49}`);
  })().catch((err) => {
    inspectWebKitBridge = null;
    throw err;
  });
  return inspectWebKitBridge;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function forwardedProtoForRequest(req: SimReq): string | undefined {
  return firstHeaderValue(req.headers["x-forwarded-proto"])
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
}

function websocketProtocolForRequest(req: SimReq): "ws" | "wss" {
  return forwardedProtoForRequest(req) === "https" ? "wss" : "ws";
}

function httpProtocolForRequest(req: SimReq): "http" | "https" {
  return forwardedProtoForRequest(req) === "https" ? "https" : "http";
}

function devtoolsFrontendUrl(
  frontendBase: string,
  wsParamName: "ws" | "wss",
  wsTargetBase: string,
  targetId: string,
): string {
  const url = new URL(`${frontendBase}/inspector.html`, "http://serve-sim.local");
  url.searchParams.set(wsParamName, `${wsTargetBase}/page/${encodeURIComponent(targetId)}`);
  return `${url.pathname}${url.search}`;
}

let _html: string | null = null;
/**
 * Best-effort absolute path to the running serve-sim entry script. Used so
 * the in-page Camera tool can `node <path> camera ...` regardless of PATH.
 * Falls back to the literal `serve-sim` if we can't determine a usable path.
 */
function serveSimBinPath(): string {
  try {
    const argv = process.argv;
    if (argv[1] && existsSync(argv[1])) return argv[1];
  } catch {}
  return "serve-sim";
}

function loadHtml(): string {
  if (!_html) {
    _html = Buffer.from(__PREVIEW_HTML_B64__, "base64").toString("utf-8");
  }
  return _html;
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
  runtime: string;
}

function listAllSimulators(): Promise<SimctlDevice[]> {
  return new Promise((resolve) => {
    execFile(
      "xcrun",
      ["simctl", "list", "devices", "-j"],
      { encoding: "utf-8", timeout: 3_000 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const data = JSON.parse(stdout) as SimctlAllList;
          const out: SimctlDevice[] = [];
          for (const [runtime, devices] of Object.entries(data.devices)) {
            // Keep this to touch-capable simulator families that serve-sim can
            // frame and inject into. tvOS is intentionally left out for now.
            if (!/SimRuntime\.(iOS|watchOS|visionOS|xrOS)-/i.test(runtime)) continue;
            for (const d of devices) {
              if (d.isAvailable === false) continue;
              out.push({ ...d, runtime: runtime.replace(/^.*SimRuntime\./, "") });
            }
          }
          resolve(out);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

// Default per-simulator footprint when we have no running sim to measure
// from — a fresh booted iOS sim with one app launched typically sits in
// the 1.2–1.8 GB range. Used as a fallback only.
const DEFAULT_PER_SIM_BYTES = 1.5 * 1024 * 1024 * 1024;

interface MemoryReport {
  totalBytes: number;
  availableBytes: number;
  runningSimulators: number;
  perSimAvgBytes: number;
  perSimSource: "measured" | "estimated";
  estimatedAdditional: number;
}

function readSystemMemory(): { totalBytes: number; availableBytes: number } {
  try {
    const totalBytes = Number(
      execSync("sysctl -n hw.memsize", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
      }).trim(),
    );
    const pageSize = Number(
      execSync("sysctl -n hw.pagesize", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
      }).trim(),
    );
    const vmStat = execSync("vm_stat", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    const pages = (re: RegExp) => {
      const m = vmStat.match(re);
      return m ? Number(m[1]) : 0;
    };
    // "Available" mirrors what Activity Monitor treats as reclaimable: free
    // + inactive + speculative pages. Excludes wired and active.
    const availablePages =
      pages(/Pages free:\s+(\d+)/) +
      pages(/Pages inactive:\s+(\d+)/) +
      pages(/Pages speculative:\s+(\d+)/);
    return {
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0,
      availableBytes: availablePages * (Number.isFinite(pageSize) ? pageSize : 4096),
    };
  } catch {
    return { totalBytes: 0, availableBytes: 0 };
  }
}

// Sum RSS across every process whose argv path includes a CoreSimulator
// device directory. Groups by UDID so we get a real per-sim footprint that
// covers launchd_sim plus all child processes the runtime spawns.
function readSimulatorMemoryUsage(): { perUdid: Record<string, number>; totalBytes: number } {
  try {
    const output = execSync("ps -axo rss=,args=", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const perUdid: Record<string, number> = {};
    let totalBytes = 0;
    const re = /\/Devices\/([0-9A-F-]{36})\//i;
    for (const raw of output.split("\n")) {
      const line = raw.trimStart();
      if (!line) continue;
      const m = re.exec(line);
      if (!m) continue;
      const rssKb = Number(line.split(/\s+/, 1)[0]);
      if (!Number.isFinite(rssKb)) continue;
      const bytes = rssKb * 1024;
      const udid = m[1]!.toUpperCase();
      perUdid[udid] = (perUdid[udid] ?? 0) + bytes;
      totalBytes += bytes;
    }
    return { perUdid, totalBytes };
  } catch {
    return { perUdid: {}, totalBytes: 0 };
  }
}

function buildMemoryReport(): MemoryReport {
  const { totalBytes, availableBytes } = readSystemMemory();
  const usage = readSimulatorMemoryUsage();
  const runningSimulators = Object.keys(usage.perUdid).length;
  const measuredAvg = runningSimulators > 0
    ? usage.totalBytes / runningSimulators
    : 0;
  // Below ~256MB, the measurement is almost certainly catching a sim mid-boot
  // before its app processes are resident — fall back to the default so we
  // don't over-promise capacity.
  const perSimSource: MemoryReport["perSimSource"] =
    measuredAvg >= 256 * 1024 * 1024 ? "measured" : "estimated";
  const perSimAvgBytes =
    perSimSource === "measured" ? measuredAvg : DEFAULT_PER_SIM_BYTES;
  const estimatedAdditional = perSimAvgBytes > 0
    ? Math.max(0, Math.floor(availableBytes / perSimAvgBytes))
    : 0;
  return {
    totalBytes,
    availableBytes,
    runningSimulators,
    perSimAvgBytes,
    perSimSource,
    estimatedAdditional,
  };
}

export interface SimMiddlewareOptions {
  /** Base path to serve the preview at. Default: "/.sim" */
  basePath?: string;
  /** Pin this preview server to a specific simulator UDID. */
  device?: string;
  /**
   * Per-session bearer token gating the `/exec` shell-exec route.
   * Auto-generated if omitted. The token is injected into the preview HTML
   * so the in-page UI can call `/exec` same-origin; LAN attackers and
   * cross-origin pages cannot read it.
   */
  execToken?: string;
  /**
   * Pin the preview stream codec. `"mjpeg"` forces the software JPEG path for
   * hosts whose hardware can't encode H.264 (e.g. VMs without the high/low-
   * latency H.264 profiles); `"auto"`/undefined lets the browser pick H.264.
   * Reserved for future values such as `"hevc"`/`"av1"`.
   */
  codec?: string;
  /**
   * Route the browser's helper stream/control and DevTools sockets through the
   * preview's same-origin `/helper` and `/devtools` proxies instead of the
   * helper's own loopback port — so a single exposed preview port is enough for
   * remote viewers. Requires the mounting server to forward WebSocket `upgrade`
   * events to {@link SimMiddleware.handleUpgrade}. Standalone `serve-sim`
   * enables this; plain `app.use(simMiddleware(...))` mounts leave it off (and
   * keep direct helper URLs) unless they also wire upgrades. See the README's
   * "Embed in your dev server" section.
   */
  proxyHelpers?: boolean;
  /** Test hook for supplying a fake inspect-webkit bridge. */
  inspectWebKitBridge?: () => Promise<WebKitBridge>;
}

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  // `application/json; charset=utf-8` etc. — only the media type matters.
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json";
}

/**
 * Connect-style middleware that serves the simulator preview UI.
 *
 * Routes handled under `basePath` (default `/.sim`):
 *   GET  {basePath}         — the preview HTML page
 *   GET  {basePath}/api     — serve-sim state JSON
 *   GET  {basePath}/ax      — SSE stream of normalized accessibility snapshots
 */
export function simMiddleware(options?: SimMiddlewareOptions): SimMiddleware {
  const base = (options?.basePath ?? "/.sim").replace(/\/+$/, "");
  const helperPrefix = helperProxyPrefix(base);
  const devtoolsPrefix = devtoolsProxyPrefix(base);
  const proxyHelpers = options?.proxyHelpers ?? false;
  const getInspectWebKitBridge = options?.inspectWebKitBridge ?? ensureInspectWebKitBridge;
  // Per-process random token. Anyone who can read the preview HTML same-origin
  // can call /exec; cross-origin pages and LAN clients cannot, because they
  // can't read this value (it's only injected into the preview page's config).
  const execToken = options?.execToken ?? randomBytes(32).toString("base64url");

  // Simulator-settings requests run in-process (just the underlying simctl /
  // ax-tool spawn) instead of round-tripping a full `node <cli>` exec per
  // sidebar interaction.
  const handleUiRequest: UiRequestHandler = async (payload) => {
    const p = (payload ?? {}) as { device?: string; option?: string; value?: string };
    if (typeof p.device !== "string" || !/^[0-9A-Za-z-]+$/.test(p.device)) {
      throw new Error("missing or invalid device udid");
    }
    if (p.option === undefined) {
      return { status: await getUiStatus(p.device) };
    }
    if (!UI_OPTIONS[p.option]) throw new Error(`unknown option: ${p.option}`);
    const value = typeof p.value === "string" ? normalizeUiValue(p.option, p.value) : null;
    if (value === null) throw new Error(`invalid value for ${p.option}: ${p.value}`);
    await setUiOption(p.device, p.option, value);
    try {
      recordEventLogEvent({
        device: p.device,
        source: "ui",
        kind: "ui-setting",
        action: p.option,
        status: "ok",
        summary: `UI ${p.option} ${value}`,
        details: { option: p.option, value },
      });
    } catch {
      // Event-log recording is diagnostic; it must not fail the UI request.
    }
    return { ok: true };
  };

  const middleware = (async (req: SimReq, res: SimRes, next?: SimNext) => {
    const rawUrl: string = req.url ?? "";
    const qIndex = rawUrl.indexOf("?");
    const url = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const requestedDevice = queryDevice(rawUrl);
    const selectedDevice = requestedDevice ?? options?.device ?? null;
    const devtoolsFrontendBase = base === "/" ? "/devtools-frontend" : `${base}/devtools-frontend`;

    const helperTarget = helperProxyTarget(rawUrl, helperPrefix);
    if (helperTarget) {
      const device = helperTarget.device ?? selectedDevice;
      // The device's helper endpoints are served from an in-process
      // NativeCapture/NativeHid DeviceSession.
      if (serveHelperInProcess(req, res, device, helperTarget.upstreamPath)) return;
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("No serve-sim device");
      return;
    }

    // Same-origin proxy for Chrome DevTools frontend assets. Loading the
    // appspot-hosted frontend directly works as a top-level tab, but is flaky
    // inside embedded browser iframes. Serving it from the preview origin keeps
    // the frontend's relative assets and CSP on the local page.
    if (url === devtoolsFrontendBase || url.startsWith(`${devtoolsFrontendBase}/`)) {
      const assetPath = url === devtoolsFrontendBase
        ? "inspector.html"
        : url.slice(devtoolsFrontendBase.length + 1);
      // Reject path-traversal segments before they reach the upstream URL.
      if (assetPath.split("/").some((seg) => seg === "..")) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid asset path");
        return;
      }
      try {
        const upstream = await fetch(
          `https://chrome-devtools-frontend.appspot.com/serve_rev/@${DEVTOOLS_FRONTEND_REV}/${assetPath}${qIndex === -1 ? "" : rawUrl.slice(qIndex)}`,
        );
        const headers: Record<string, string> = {
          "Cache-Control": "public, max-age=604800",
        };
        const contentType = upstream.headers.get("content-type");
        if (contentType) headers["Content-Type"] = contentType;
        res.writeHead(upstream.status, headers);
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (err) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(err instanceof Error ? err.message : "Failed to load DevTools frontend");
      }
      return;
    }

    // Serve the preview page
    if (url === base || url === base + "/") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      let html = loadHtml();

      if (!state) {
        // Empty-state UI still polls /exec (boot/list helpers), so the page
        // needs the bearer token even before a helper attaches. Inject a
        // minimal config with just the basePath + token.
        const minimal = JSON.stringify({ basePath: base, execToken });
        html = html.replace(
          "<!--__SIM_PREVIEW_CONFIG__-->",
          `<script>window.__SIM_PREVIEW__=${minimal}</script>`,
        );
      }

      if (state) {
        const remoteState = rewriteStateForRequestHost(state, hostForRequest(req), base, httpProtocolForRequest(req), proxyHelpers);
        const config = JSON.stringify(previewConfigForState(remoteState, base, serveSimBinPath(), execToken, options?.codec, proxyHelpers));
        const configScript = `<script>window.__SIM_PREVIEW__=${config}</script>`;
        html = html.replace("<!--__SIM_PREVIEW_CONFIG__-->", configScript);
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    // Memory capacity estimate: how much room is left to boot more sims.
    if (url === base + "/grid/api/memory") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(buildMemoryReport()));
      return;
    }

    if (url === base + "/grid/api/devicekit-chrome") {
      serveDeviceKitChromeAsset(new URL(rawUrl || "/", "http://serve-sim.local"), res);
      return;
    }

    if (url === base + "/grid/api/device-placeholder-asset") {
      serveDevicePlaceholderAsset(new URL(rawUrl || "/", "http://serve-sim.local"), res);
      return;
    }

    // Grid JSON: every supported simulator, annotated with running helper info if any.
    if (url === base + "/grid/api") {
      const states = await readServeSimStates();
      const helperByUdid = new Map(states.map((s) => [s.device, s] as const));
      const sims = await listAllSimulators();
      // Order mirrors Xcode's Devices window: the devices the user is actually
      // using float to the top — streaming first, then booted, then the
      // simulator they last opened in Simulator.app — and everything else falls
      // back to a stable family / newest-OS / name grouping. This surfaces the
      // handful of relevant devices instead of burying them in an alphabetical
      // wall of near-identical names. Sort on the cheap metadata BEFORE
      // resolving the DeviceKit chrome descriptor, so pagination resolves chrome
      // only for the page actually returned.
      const preferredUdid = getPreferredDeviceUdid();
      const familyRank = (name: string): number => {
        if (/iphone/i.test(name)) return 0;
        if (/ipad/i.test(name)) return 1;
        if (/watch/i.test(name)) return 2;
        if (/(apple\s*tv|^tv\b)/i.test(name)) return 3;
        if (/vision|reality/i.test(name)) return 4;
        return 5;
      };
      // Lower is higher in the list: streaming > selected > booted > last-opened
      // > rest. The active `?device=` selection is ranked near the top so it's
      // always inside the first page — otherwise a paginated client that selected
      // a shut-down device deep in the catalog would get no chrome/placeholder
      // for the view it's actually showing.
      const stateRank = (d: (typeof sims)[number]) => {
        if (helperByUdid.has(d.udid)) return 0;
        if (selectedDevice && d.udid === selectedDevice) return 1;
        if (d.state === "Booted") return 2;
        if (d.udid === preferredUdid) return 3;
        return 4;
      };
      // Newest runtime first, so "iPhone 17 Pro (27.0)" sorts above its 26.x twins.
      const runtimeRank = (runtime: string): number => {
        const m = runtime.match(/-(\d+)-(\d+)/);
        const major = m ? Number(m[1]) : 0;
        const minor = m ? Number(m[2]) : 0;
        return -(major * 1000 + minor);
      };
      sims.sort((a, b) =>
        stateRank(a) - stateRank(b) ||
        familyRank(a.name) - familyRank(b.name) ||
        a.name.localeCompare(b.name) ||
        runtimeRank(a.runtime) - runtimeRank(b.runtime),
      );

      const total = sims.length;
      const { limit, offset } = parseGridPaging(rawUrl);
      const page = limit == null ? sims : sims.slice(offset, offset + limit);
      const devices = page.map((d) => {
        const helper = helperByUdid.get(d.udid);
        const remoteHelper = helper ? rewriteStateForRequestHost(helper, hostForRequest(req), base, httpProtocolForRequest(req), proxyHelpers) : null;
        return {
          device: d.udid,
          name: d.name,
          runtime: d.runtime,
          state: d.state,
          chrome: resolveDeviceKitChrome(d),
          placeholderAsset: resolveDevicePlaceholderAsset(d),
          helper: remoteHelper
            ? {
                port: remoteHelper.port,
                url: remoteHelper.url,
                streamUrl: remoteHelper.streamUrl,
                wsUrl: remoteHelper.wsUrl,
              }
            : null,
        };
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      // `total` lets the client show "X of Y" and know when to stop paging;
      // older clients that read only `devices` are unaffected.
      res.end(JSON.stringify({ devices, total, offset: limit == null ? 0 : offset, limit: limit ?? total }));
      return;
    }

    // Shutdown a booted simulator. Any running helper for the device is reaped
    // by readServeSimStates() on the next /grid/api poll (it kills helpers
    // whose backing simulator is no longer in the booted set).
    if (url === base + "/grid/api/shutdown" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += typeof chunk === "string" ? chunk : chunk.toString();
      });
      req.on("end", () => {
        let udid = "";
        try { udid = (JSON.parse(body) as ShutdownRequestBody).udid ?? ""; } catch {}
        if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(udid)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid or missing udid" }));
          return;
        }
        // Stop our own in-process capture for this device first (no-op if it
        // isn't streamed here). This frees the native session immediately
        // rather than waiting for the next poll's reaper to notice.
        closeDeviceSession(udid);
        // Drop the snapshot so the next /grid/api call re-queries simctl
        // and prunes any helper bound to this now-shutdown device.
        bootedSnapshot = { at: 0, booted: null };
        execFile("xcrun", ["simctl", "shutdown", udid], { timeout: 30_000 }, (err, _stdout, stderr) => {
          if (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ok: false,
              error: stderr?.toString().trim() || err.message,
            }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      return;
    }

    // Start streaming a device in-process (auto-boots if needed). The preview
    // server serves its /helper routes directly — no spawned helper.
    if (url === base + "/grid/api/start" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += typeof chunk === "string" ? chunk : chunk.toString();
      });
      req.on("end", () => {
        let udid = "";
        try { udid = (JSON.parse(body) as StartRequestBody).udid ?? ""; } catch {}
        if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(udid)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid or missing udid" }));
          return;
        }
        const port = req.socket.localPort ?? 0;
        void startDeviceInProcess(udid, port, base).then((error) => {
          if (res.writableEnded) return;
          if (error) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          }
        });
      });
      return;
    }

    // JSON API: start the inspect-webkit CDP bridge and list WebKit targets
    // for the selected simulator. The bridge itself serves /json/list and
    // /devtools/page/:id on localhost; the preview adds iframe-safe frontend
    // URLs so the browser UI can embed Chrome DevTools.
    if (url === base + "/devtools") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No serve-sim device" }));
        return;
      }
      try {
        const bridge = await getInspectWebKitBridge();
        const bridgeTargets = await bridge.listTargets();
        // Proxy mode routes the inspector socket through the preview's
        // same-origin `/devtools` proxy; otherwise the browser talks to the
        // bridge's loopback port directly (the pre-proxy behavior).
        const wsProtocol = proxyHelpers ? websocketProtocolForRequest(req) : "ws";
        const wsTargetBase = proxyHelpers
          ? `${hostForRequest(req) ?? `127.0.0.1:${bridge.port}`}${devtoolsPrefix}`
          : `127.0.0.1:${bridge.port}/devtools`;
        // inspect-webkit@0.0.3 only exposes `sim:<webinspectord-pid>` for
        // simulator targets, which can't be reconciled against a sim UDID.
        // Surface every booted sim's targets (Safari Develop-menu behavior)
        // until inspect-webkit grows a real UDID we can filter on.
        const targets = bridgeTargets.map((target) => ({
          ...target,
          webSocketDebuggerUrl: `${wsProtocol}://${wsTargetBase}/page/${encodeURIComponent(target.id)}`,
          devtoolsFrontendUrl: devtoolsFrontendUrl(devtoolsFrontendBase, wsProtocol, wsTargetBase, target.id),
        }));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({
          port: bridge.port,
          targets,
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: err instanceof Error ? err.message : "Failed to start inspect-webkit",
        }));
      }
      return;
    }

    // POST /devtools/release — drop hover-highlight CDP sessions so we don't
    // sit on a WIR slot when the picker is dismissed (or the tab is closed).
    // Optional body { targetId } releases just one; empty body releases all.
    if (url === base + "/devtools/release" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed: ReleaseRequestBody = body ? JSON.parse(body) : {};
          const bridge = await getInspectWebKitBridge();
          bridge.releaseHighlight?.(parsed.targetId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: err instanceof Error ? err.message : "Failed to release",
          }));
        }
      });
      return;
    }

    // POST /devtools/highlight — flash an inspectable target in the
    // simulator the way Safari's Develop menu hover does. Body shape:
    // { targetId: string, on: boolean }.
    if (url === base + "/devtools/highlight" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk));
      req.on("end", async () => {
        try {
          const { targetId, on } = JSON.parse(body || "{}") as HighlightRequestBody;
          if (!targetId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing targetId" }));
            return;
          }
          const bridge = await getInspectWebKitBridge();
          if (!bridge.highlightTarget) {
            res.writeHead(501, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "highlightTarget not supported by inspect-webkit" }));
            return;
          }
          await bridge.highlightTarget(targetId, !!on);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: err instanceof Error ? err.message : "Failed to highlight target",
          }));
        }
      });
      return;
    }

    // JSON API: serve-sim state
    if (url === base + "/api") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      // The web UI polls /api every ~2s, so logging every hit floods the
      // debug stream with identical lines. Only log when the selection
      // result changes.
      const apiLogKey = `${selectedDevice ?? "(any)"}|${states.length}|${
        state ? `${state.device}@${state.port}` : "none"
      }`;
      if (apiLogKey !== lastApiLogKey) {
        lastApiLogKey = apiLogKey;
        debugMw(
          "GET /api selectedDevice=%s states=%d chose=%s",
          selectedDevice ?? "(any)",
          states.length,
          state ? `${state.device}@${state.port}` : "none",
        );
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      const remoteState = state ? rewriteStateForRequestHost(state, hostForRequest(req), base, httpProtocolForRequest(req), proxyHelpers) : null;
      res.end(JSON.stringify(remoteState ? previewConfigForState(remoteState, base, serveSimBinPath(), execToken, options?.codec, proxyHelpers) : null));
      return;
    }

    // JSON API: recent simulator action log. This is intentionally in-memory and
    // bounded; it is for live debugging/agent observability, not archival audit.
    if (url === base + "/api/event-log") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({
        events: readEventLog({
          device: requestedDevice,
          sinceId: eventLogSinceId(rawUrl),
          limit: eventLogLimit(rawUrl),
        }),
      }));
      return;
    }

    // SSE: action log stream. Sends a snapshot first, then individual new
    // entries. The exec-ws control channel proxies this route for the browser UI.
    if (url === base + "/api/event-log/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");
      res.write("data: " + JSON.stringify({
        events: readEventLog({
          device: requestedDevice,
          sinceId: eventLogSinceId(rawUrl),
          limit: eventLogLimit(rawUrl),
        }),
      }) + "\n\n");

      const unsubscribe = subscribeEventLog((event) => {
        if (requestedDevice && event.device !== requestedDevice) return;
        if (res.writableEnded) return;
        res.write("data: " + JSON.stringify({ event }) + "\n\n");
      });
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(":\n\n");
      }, 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    // SSE: serve-sim state stream. Push replacement for the web UI's old ~1.5s
    // /api poll — the PreviewConfig only changes when a helper boots/shuts down
    // or the device selection changes, so we watch the state dir and emit only
    // on change instead of re-sending identical JSON on a fixed interval.
    if (url === base + "/api/events") {
      const computeConfig = async (): Promise<string> => {
        const states = await readServeSimStates();
        const state = selectServeSimState(states, selectedDevice);
        const remoteState = state ? rewriteStateForRequestHost(state, hostForRequest(req), base, httpProtocolForRequest(req), proxyHelpers) : null;
        return JSON.stringify(
          remoteState ? previewConfigForState(remoteState, base, serveSimBinPath(), execToken, options?.codec, proxyHelpers) : null,
        );
      };

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");

      let lastSent = await computeConfig();
      res.write("data: " + lastSent + "\n\n");

      let closed = false;
      const sendIfChanged = async () => {
        if (closed || res.writableEnded) return;
        const next = await computeConfig();
        if (next === lastSent) return;
        lastSent = next;
        res.write("data: " + next + "\n\n");
      };

      // Debounce filesystem events: a helper boot rewrites the state file a few
      // times in quick succession, and selectServeSimState also shells out to
      // refresh booted devices, so coalesce bursts into one recompute.
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const onFsEvent = () => {
        if (debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          sendIfChanged();
        }, 150);
      };

      let watcher: FSWatcher | null = null;
      let watcherRetry: ReturnType<typeof setTimeout> | null = null;
      const ensureWatcher = () => {
        if (closed || res.writableEnded || watcher || watcherRetry) return;
        watcherRetry = setTimeout(() => {
          watcherRetry = null;
          if (closed || res.writableEnded || watcher) return;
          try {
            watcher = watch(STATE_DIR, onFsEvent);
            watcher.on("error", () => {
              watcher?.close();
              watcher = null;
              ensureWatcher();
            });
            sendIfChanged();
          } catch {
            ensureWatcher();
          }
        }, 250);
      };
      ensureWatcher();

      // Keep the connection alive through buffering proxies + catch any change
      // an fs event missed (e.g. dir created after we failed to watch it).
      const heartbeat = setInterval(() => {
        if (closed || res.writableEnded) return;
        res.write(":\n\n");
        ensureWatcher();
      }, 15000);

      req.on("close", () => {
        closed = true;
        if (debounce) clearTimeout(debounce);
        if (watcherRetry) clearTimeout(watcherRetry);
        clearInterval(heartbeat);
        watcher?.close();
      });
      return;
    }

    // SSE: normalized accessibility snapshot stream
    if (url === base + "/ax") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        res.writeHead(404);
        res.end("No serve-sim device");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");
      axStreamerCache.prune(states.map((s) => s.device));
      const ax = axStreamerCache.get(state.device);
      const removeClient = ax.addClient(res);
      req.on("close", removeClient);
      return;
    }

    // POST /exec — run a shell command on the host. Gated by a per-process
    // bearer token injected only into the same-origin preview HTML, with
    // Content-Type + Origin checks to block CORS-simple CSRF (a malicious
    // page POSTing `text/plain` JSON to a dev server bound to a public iface)
    // and LAN attackers who can reach the port but can't read the token.
    if ((url === base + "/exec" || url === base + "/exec/") && req.method === "POST") {
      // 1. Reject anything that isn't a JSON request, killing the
      //    `enctype="text/plain"` CORS-simple form-POST path.
      if (!isJsonContentType(req.headers["content-type"])) {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stdout: "", stderr: "Unsupported Media Type", exitCode: 1 }));
        return;
      }
      // 2. If the browser supplied an Origin, require it match this server.
      //    Same-origin XHR from the preview page sets Origin to our own URL;
      //    a cross-origin page's Origin won't match.
      const origin = req.headers.origin;
      if (origin) {
        try {
          const originHost = new URL(origin).host;
          if (originHost !== req.headers.host) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ stdout: "", stderr: "Cross-origin request blocked", exitCode: 1 }));
            return;
          }
        } catch {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ stdout: "", stderr: "Invalid Origin", exitCode: 1 }));
          return;
        }
      }
      // 3. Require the per-session bearer token. Cross-origin pages cannot
      //    read it from window.__SIM_PREVIEW__; non-browser callers must
      //    have copied it from the CLI output.
      const authHeader = req.headers.authorization ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(authHeader);
      if (!match || !safeEqualString(match[1]!.trim(), execToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stdout: "", stderr: "Unauthorized", exitCode: 1 }));
        return;
      }
      let body = "";
      let aborted = false;
      req.on("data", (chunk: Buffer | string) => {
        body += typeof chunk === "string" ? chunk : chunk.toString();
        // Cheap belt-and-braces cap so a runaway POST can't OOM the dev server.
        if (body.length > 4 * 1024 * 1024) {
          aborted = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ stdout: "", stderr: "Payload Too Large", exitCode: 1 }));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (aborted) return;
        let command = "";
        try {
          command = (JSON.parse(body) as ExecRequestBody).command ?? "";
        } catch {}
        if (!command) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ stdout: "", stderr: "Missing command", exitCode: 1 }));
          return;
        }
        exec(command, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          const exitCode = err ? (err as ExecException).code ?? 1 : 0;
          recordCommandEvent(command, { exitCode });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode,
          }));
        });
      });
      return;
    }

    // SSE: foreground-app change stream. Emits `{bundleId, pid}` events
    // parsed from SpringBoard's "Setting process visibility to: Foreground"
    // log line. Filtering is done here (not in the browser) so the SSE stream
    // stays narrow and the client can listen without rate-limit concerns.
    if (url === base + "/appstate") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        res.writeHead(404);
        res.end("No serve-sim device");
        return;
      }
      const udid = state.device;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");

      // Bootstrap: SpringBoard's log feed is edge-triggered, so a fresh
      // subscriber would otherwise see nothing until the user re-foregrounds
      // an app (the bug: tools couldn't reconnect after a page reload). Ask
      // the helper's AX bridge for the current frontmost app via
      // `proc_pidpath`+Info.plist resolution and emit it before tailing.
      let lastBundle = "";
      try {
        const info = JSON.parse(await axFrontmostAsync(udid)) as { bundleId?: string; pid?: number };
        if (!info.bundleId || !isUserFacingBundle(info.bundleId)) return;
        if (res.writableEnded) return;
        lastBundle = info.bundleId;
        const isReactNative = await detectReactNative(udid, info.bundleId);
        if (res.writableEnded) return;
        res.write("data: " + JSON.stringify({ bundleId: info.bundleId, pid: info.pid, isReactNative }) + "\n\n");
      } catch {
        // AX bridge may be warming up — the log tail fills in once anything moves.
      }

      const child: ChildProcess = spawn("xcrun", [
        "simctl", "spawn", udid, "log", "stream",
        "--style", "ndjson",
        "--level", "info",
        "--predicate",
        'process == "SpringBoard" AND eventMessage CONTAINS "Setting process visibility to: Foreground"',
      ], { stdio: ["ignore", "pipe", "ignore"] });

      let closed = false;
      const emitApp = async (bundleId: string, pid?: number) => {
        if (!isUserFacingBundle(bundleId)) return;
        if (bundleId === lastBundle) return;
        lastBundle = bundleId;
        const isReactNative = await detectReactNative(udid, bundleId);
        if (!closed) {
          res.write("data: " + JSON.stringify({ bundleId, pid, isReactNative }) + "\n\n");
        }
      };


      let buf = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: string;
          try { msg = JSON.parse(line).eventMessage ?? ""; } catch { continue; }
          const event = parseForegroundAppLogMessage(msg);
          if (!event) continue;
          emitApp(event.bundleId, event.pid);
        }
        if (buf.length > SSE_LINE_BUFFER_LIMIT) buf = "";
      });

      child.on("error", () => {
        closed = true;
        try { res.end(); } catch {}
      });
      child.on("close", () => res.end());
      req.on("close", () => {
        closed = true;
        child.stdout?.destroy();
        child.kill();
      });
      return;
    }

    // Not ours — pass through
    if (next) return next();
  }) as SimMiddleware;
  middleware.handleUpgrade = (req: SimReq, socket: Socket, head: Buffer) => {
    const rawUrl = req.url ?? "";
    const selectedDevice = queryDevice(rawUrl) ?? options?.device ?? null;
    const helperTarget = helperProxyTarget(rawUrl, helperPrefix);
    const devtoolsTarget = devtoolsProxyTarget(rawUrl, devtoolsPrefix);
    if (devtoolsTarget) {
      (async () => {
        try {
          const bridge = await getInspectWebKitBridge();
          bridgeWebSocketFrames(req, socket, head, `ws://127.0.0.1:${bridge.port}${devtoolsTarget.upstreamPath}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to start inspect-webkit";
          socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}`);
        }
      })();
      return;
    }
    if (!helperTarget) {
      socket.destroy();
      return;
    }
    const device = helperTarget.device ?? selectedDevice;
    if (helperTarget.upstreamPath === "/ws") {
      // HID input is delivered to the in-process DeviceSession.
      if (attachHidInProcess(req, socket, head, device)) return;
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  };
  // WebSocket exec channel — same auth/origin policy as POST /exec, but off
  // the browser's per-origin HTTP connection pool so multiple preview tabs
  // (each holding MJPEG + SSE streams) can't starve exec actions. Servers
  // mounting this middleware should forward `upgrade` events here (the
  // built-in preview server does); the client falls back to POST /exec when
  // the upgrade never completes.
  const handleExecUpgrade = createExecUpgradeHandler({
    path: `${base}/exec-ws`,
    execToken,
    ssePrefixes: [
      `${base}/api/events`,
      `${base}/api/event-log/events`,
      `${base}/appstate`,
      `${base}/ax`,
    ],
    onUiRequest: handleUiRequest,
    onCommandResult: (command, result) => recordCommandEvent(command, result),
  });

  // WebSocket upgrades owned by the preview: the authenticated exec/control
  // channel plus same-origin helper/devtools proxy sockets.
  const handleProxyUpgrade = middleware.handleUpgrade;
  middleware.handleUpgrade = (req: SimReq, socket: Socket, head: Buffer) => {
    if (handleExecUpgrade(req, socket, head)) return;
    handleProxyUpgrade(req, socket, head);
  };
  return middleware;
}
