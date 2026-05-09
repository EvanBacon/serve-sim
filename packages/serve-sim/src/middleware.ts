import { readdirSync, readFileSync, existsSync, unlinkSync } from "fs";
import { execSync, spawn, exec, execFile, type ChildProcess } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { createServer as createNetServer } from "net";
import { createAxStreamerCache } from "./ax";

// Injected at build time as a base64-encoded string via `define`
declare const __PREVIEW_HTML_B64__: string;
const STATE_DIR = join(tmpdir(), "serve-sim");
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

type WebKitBridge = {
  port: number;
  cdpUrl: string;
  listTargets(): Promise<WebKitBridgeTarget[]>;
  highlightTarget?(targetId: string, on: boolean): Promise<void>;
  releaseHighlight?(targetId?: string): void;
};

export interface ServeSimState {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
}

const axStreamerCache = createAxStreamerCache();
let inspectWebKitBridge: Promise<WebKitBridge> | null = null;

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

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function installedAppsForDevice(udid: string): Promise<Record<string, InstalledApp>> {
  return new Promise((resolve) => {
    exec(
      `xcrun simctl listapps ${shellQuote(udid)} | plutil -convert json -o - -`,
      { timeout: 3_000 },
      (err, stdout) => {
        if (err || !stdout) return resolve({});
        try {
          resolve(JSON.parse(stdout) as Record<string, InstalledApp>);
        } catch {
          resolve({});
        }
      },
    );
  });
}

async function detectCurrentForegroundApp(
  udid: string,
  stateUrl: string,
): Promise<{ bundleId: string; isReactNative: boolean } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(`${stateUrl}/ax`, { signal: controller.signal });
    if (!res.ok) return null;
    const tree = await res.json() as Array<{ AXLabel?: unknown }>;
    const displayName = tree?.[0]?.AXLabel;
    if (typeof displayName !== "string") return null;

    const bundleId = matchInstalledAppByDisplayName(
      await installedAppsForDevice(udid),
      displayName,
    );
    if (!bundleId || !isUserFacingBundle(bundleId)) return null;
    return { bundleId, isReactNative: await detectReactNative(udid, bundleId) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Cache simctl's booted-device set briefly so per-request cost stays bounded.
// The middleware runs inside the user's dev server (Metro etc.) and
// readServeSimStates() is called on every /api and every page load.
let bootedSnapshot: { at: number; booted: Set<string> | null } = { at: 0, booted: null };
function getBootedUdids(): Set<string> | null {
  const now = Date.now();
  if (bootedSnapshot.booted && now - bootedSnapshot.at < 1500) {
    return bootedSnapshot.booted;
  }
  try {
    const output = execSync("xcrun simctl list devices booted -j", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3_000,
    });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
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

function readServeSimStates(): ServeSimState[] {
  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter(
      (f) => f.startsWith("server-") && f.endsWith(".json"),
    );
  } catch {
    return [];
  }
  const booted = getBootedUdids();
  const states: ServeSimState[] = [];
  for (const f of files) {
    const path = join(STATE_DIR, f);
    try {
      const state: ServeSimState = JSON.parse(readFileSync(path, "utf-8"));
      try {
        process.kill(state.pid, 0);
      } catch {
        try { unlinkSync(path); } catch {}
        continue;
      }
      // Helper alive but its simulator was shut down — the MJPEG stream
      // would accept connections yet never produce frames, leaving the
      // preview stuck on "Connecting...". Recycle the stale state so the
      // caller can spawn a fresh helper bound to whatever is booted.
      if (booted && !booted.has(state.device)) {
        try { process.kill(state.pid, "SIGTERM"); } catch {}
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

function endpoint(base: string, path: string, device: string): string {
  const value = `${base}${path}`;
  return `${value}?device=${encodeURIComponent(device)}`;
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
    const version = await versionRes.json() as { Browser?: string };
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
        const targets = await listRes.json() as Array<{
          id: string;
          title: string;
          url: string;
          type: string;
          description?: string;
        }>;
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
        // Bind explicitly to IPv4 127.0.0.1 to match what bridgeWsHost emits
        // (and what the DevTools frontend CSP whitelists). `localhost` resolves
        // to ::1 first on some setups, which would leave the iframe's
        // ws://127.0.0.1:9222 connection refused.
        const server = await startCdpServer({ host: "127.0.0.1", port });
        return {
          port,
          cdpUrl: `http://127.0.0.1:${port}`,
          async listTargets() {
            return server.getTargets()
              .filter((target: any) => target.source?.kind === "simulator")
              .map((target: any) => ({
                id: target.targetId,
                title: target.title || target.appName || target.url || "Untitled",
                url: /^https?:/i.test(target.url) ? target.url : "about:blank",
                type: target.type || "page",
                appName: target.appName,
                bundleId: target.bundleId,
                udid: target.source?.id,
                inUseByOtherInspector: !!target.inUseByOtherInspector,
              }));
          },
          highlightTarget: server.highlightTarget?.bind(server),
          releaseHighlight: server.releaseHighlight?.bind(server),
        };
      } catch (err: any) {
        if (err?.code === "EADDRINUSE") {
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

function devtoolsFrontendUrl(frontendBase: string, wsHost: string, targetId: string): string {
  const url = new URL(`${frontendBase}/inspector.html`, "http://serve-sim.local");
  url.searchParams.set("ws", `${wsHost}/devtools/page/${targetId}`);
  return `${url.pathname}${url.search}`;
}

// The inspect-webkit bridge binds locally. Always emit `127.0.0.1` rather
// than `localhost` for the iframe's WS URL: the chrome-devtools-frontend
// inspector.html ships a CSP whose connect-src only whitelists
// `ws://127.0.0.1:*` (plus `'self'`, which doesn't cover the bridge's
// different port). A `ws://localhost:9222/...` connection from the iframe
// gets CSP-blocked and surfaces as "WebSocket disconnected."
// Non-local hostnames fall back to 127.0.0.1 since the bridge isn't
// reachable from off-host anyway.
function bridgeWsHost(_reqHost: string | undefined, bridgePort: number): string {
  return `127.0.0.1:${bridgePort}`;
}

let _html: string | null = null;
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
  runtime: string;
}

function listAllSimulators(): SimctlDevice[] {
  try {
    const output = execSync("xcrun simctl list devices -j", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<Omit<SimctlDevice, "runtime">>>;
    };
    const out: SimctlDevice[] = [];
    for (const [runtime, devices] of Object.entries(data.devices)) {
      // Only iOS (skip watchOS / tvOS / visionOS for the grid MVP — the helper
      // is iOS-focused and the bezel/touch model assumes a phone-shaped device).
      if (!/SimRuntime\.iOS-/i.test(runtime)) continue;
      for (const d of devices) {
        if (d.isAvailable === false) continue;
        out.push({ ...d, runtime: runtime.replace(/^.*SimRuntime\./, "") });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function deviceNameFor(udid: string): string | null {
  return listAllSimulators().find((d) => d.udid === udid)?.name ?? null;
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
      const udid = m[1].toUpperCase();
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

/**
 * Locate the `serve-sim` CLI binary so the grid can spawn helpers via
 * `serve-sim --detach <udid>`. Tries, in order:
 *   1. argv[0] if it ends in `serve-sim` (we're running inside the
 *      compiled standalone binary, which IS the CLI)
 *   2. `serve-sim` on PATH (npm-installed / bun-installed CLI)
 * Returns the resolved command + args ready for spawn.
 */
function resolveServeSimCommand(): { command: string; baseArgs: string[] } | null {
  // 1. Compiled standalone binary: argv[0] is the serve-sim binary itself.
  if (process.argv[0] && /(^|\/)serve-sim$/.test(process.argv[0])) {
    return { command: process.argv[0], baseArgs: [] };
  }
  // 2. Running the JS bundle directly: `node /path/to/serve-sim.js`.
  if (process.argv[1] && /(^|\/)serve-sim\.js$/.test(process.argv[1])) {
    return { command: process.argv[0]!, baseArgs: [process.argv[1]!] };
  }
  // 3. Global install: serve-sim is on PATH.
  try {
    const path = execSync("command -v serve-sim", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_500,
    }).trim();
    if (path) return { command: path, baseArgs: [] };
  } catch {}
  return null;
}

export interface SimMiddlewareOptions {
  /** Base path to serve the preview at. Default: "/.sim" */
  basePath?: string;
  /** Pin this preview server to a specific simulator UDID. */
  device?: string;
}

/**
 * Connect-style middleware that serves the simulator preview UI.
 *
 * Routes handled under `basePath` (default `/.sim`):
 *   GET  {basePath}         — the preview HTML page
 *   GET  {basePath}/api     — serve-sim state JSON
 *   GET  {basePath}/logs    — SSE stream of simctl logs
 *   GET  {basePath}/ax      — SSE stream of normalized accessibility snapshots
 */
export function simMiddleware(options?: SimMiddlewareOptions) {
  const base = (options?.basePath ?? "/.sim").replace(/\/+$/, "");

  return (req: any, res: any, next?: () => void) => {
    const rawUrl: string = req.url ?? "";
    const qIndex = rawUrl.indexOf("?");
    const url = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const selectedDevice = queryDevice(rawUrl) ?? options?.device ?? null;
    const devtoolsFrontendBase = base === "/" ? "/devtools-frontend" : `${base}/devtools-frontend`;

    // Same-origin proxy for Chrome DevTools frontend assets. Loading the
    // appspot-hosted frontend directly works as a top-level tab, but is flaky
    // inside embedded browser iframes. Serving it from the preview origin keeps
    // the frontend's relative assets and CSP on the local page.
    if (url === devtoolsFrontendBase || url.startsWith(`${devtoolsFrontendBase}/`)) {
      (async () => {
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
      })();
      return;
    }

    // Serve the preview page
    if (url === base || url === base + "/") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      let html = loadHtml();

      if (state) {
        // Pass real serve-sim URLs directly. The client parses the MJPEG
        // stream via fetch() (CORS is fine — serve-sim sends Access-Control-Allow-Origin: *)
        // and connects to the WS directly (WS has no CORS).
        const gridApiBase = (base === "" ? "" : base) + "/grid/api";
        const config = JSON.stringify({
          ...state,
          basePath: base,
          logsEndpoint: endpoint(base, "/logs", state.device),
          appStateEndpoint: endpoint(base, "/appstate", state.device),
          axEndpoint: endpoint(base, "/ax", state.device),
          devtoolsEndpoint: endpoint(base, "/devtools", state.device),
          gridApiEndpoint: gridApiBase,
          gridStartEndpoint: gridApiBase + "/start",
          gridShutdownEndpoint: gridApiBase + "/shutdown",
          gridMemoryEndpoint: gridApiBase + "/memory",
          previewEndpoint: base === "" ? "/" : base,
        });
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

    // Grid JSON: every iOS simulator, annotated with running helper info if any.
    if (url === base + "/grid/api") {
      const states = readServeSimStates();
      const helperByUdid = new Map(states.map((s) => [s.device, s] as const));
      const sims = listAllSimulators();
      const devices = sims.map((d) => {
        const helper = helperByUdid.get(d.udid);
        return {
          device: d.udid,
          name: d.name,
          runtime: d.runtime,
          state: d.state,
          helper: helper
            ? {
                port: helper.port,
                url: helper.url,
                streamUrl: helper.streamUrl,
                wsUrl: helper.wsUrl,
              }
            : null,
        };
      });
      // Stable order: family (iPhone, iPad, Watch, TV, Vision, other) →
      // state (helper > booted > shutdown) → alpha. Keeps the most
      // commonly used devices visible without scrolling.
      const familyRank = (name: string): number => {
        if (/iphone/i.test(name)) return 0;
        if (/ipad/i.test(name)) return 1;
        if (/watch/i.test(name)) return 2;
        if (/(apple\s*tv|^tv\b)/i.test(name)) return 3;
        if (/vision|reality/i.test(name)) return 4;
        return 5;
      };
      const stateRank = (x: typeof devices[number]) =>
        x.helper ? 0 : x.state === "Booted" ? 1 : 2;
      devices.sort((a, b) =>
        familyRank(a.name) - familyRank(b.name) ||
        stateRank(a) - stateRank(b) ||
        a.name.localeCompare(b.name),
      );
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ devices }));
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
        try { udid = JSON.parse(body).udid ?? ""; } catch {}
        if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(udid)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid or missing udid" }));
          return;
        }
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

    // Spawn a serve-sim helper (auto-boots if needed).
    if (url === base + "/grid/api/start" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += typeof chunk === "string" ? chunk : chunk.toString();
      });
      req.on("end", () => {
        let udid = "";
        try { udid = JSON.parse(body).udid ?? ""; } catch {}
        if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(udid)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid or missing udid" }));
          return;
        }
        const resolved = resolveServeSimCommand();
        if (!resolved) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: false,
            error: "serve-sim CLI not found in PATH. Install it (npm i -g serve-sim) and retry.",
          }));
          return;
        }
        const child = spawn(
          resolved.command,
          [...resolved.baseArgs, "--detach", udid],
          { stdio: ["ignore", "pipe", "pipe"], detached: false },
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
        child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
        // A cold iOS simulator can take 60-90s to reach `bootstatus -b`
        // readiness; the prior 60s ceiling was killing serve-sim mid-boot
        // and the helper never got a chance to spawn, so the click ended
        // with an error and no state file. 3 minutes is a comfortable
        // upper bound that covers slow first-boots without leaving a
        // wedged child around indefinitely.
        const timer = setTimeout(() => {
          try { child.kill("SIGTERM"); } catch {}
        }, 180_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, stdout: stdout.trim() }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ok: false,
              error: stderr.trim() || stdout.trim() || `serve-sim exited with code ${code}`,
            }));
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
      (async () => {
        const states = readServeSimStates();
        const state = selectServeSimState(states, selectedDevice);
        if (!state) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No serve-sim device" }));
          return;
        }
        try {
          const bridge = await ensureInspectWebKitBridge();
          const bridgeTargets = await bridge.listTargets();
          const wsHost = bridgeWsHost(req.headers?.host, bridge.port);
          // inspect-webkit@0.0.3 only exposes `sim:<webinspectord-pid>` for
          // simulator targets, which can't be reconciled against a sim UDID.
          // Surface every booted sim's targets (Safari Develop-menu behavior)
          // until inspect-webkit grows a real UDID we can filter on.
          const targets = bridgeTargets.map((target) => ({
            ...target,
            webSocketDebuggerUrl: `ws://${wsHost}/devtools/page/${encodeURIComponent(target.id)}`,
            devtoolsFrontendUrl: devtoolsFrontendUrl(devtoolsFrontendBase, wsHost, target.id),
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
      })();
      return;
    }

    // POST /devtools/release — drop hover-highlight CDP sessions so we don't
    // sit on a WIR slot when the picker is dismissed (or the tab is closed).
    // Optional body { targetId } releases just one; empty body releases all.
    if (url === base + "/devtools/release" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = body ? JSON.parse(body) as { targetId?: string } : {};
          const bridge = await ensureInspectWebKitBridge();
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
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { targetId, on } = JSON.parse(body || "{}") as { targetId?: string; on?: boolean };
          if (!targetId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing targetId" }));
            return;
          }
          const bridge = await ensureInspectWebKitBridge();
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
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(state || null));
      return;
    }

    // SSE: normalized accessibility snapshot stream
    if (url === base + "/ax") {
      const states = readServeSimStates();
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
      const ax = axStreamerCache.get(state.device, state.port);
      const removeClient = ax.addClient(res);
      req.on("close", removeClient);
      return;
    }

    // POST /exec — run a shell command on the host. The preview server binds
    // to localhost only and is meant for local dev, so we shell through
    // /bin/sh and return stdout/stderr/exitCode.
    if ((url === base + "/exec" || url === base + "/exec/") && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += typeof chunk === "string" ? chunk : chunk.toString();
      });
      req.on("end", () => {
        let command = "";
        try {
          command = JSON.parse(body).command ?? "";
        } catch {}
        if (!command) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ stdout: "", stderr: "Missing command", exitCode: 1 }));
          return;
        }
        exec(command, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: err ? (err as any).code ?? 1 : 0,
          }));
        });
      });
      return;
    }

    // SSE: simctl log stream
    if (url === base + "/logs") {
      const states = readServeSimStates();
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

      const child: ChildProcess = spawn("xcrun", [
        "simctl", "spawn", udid, "log", "stream",
        "--style", "ndjson",
        "--level", "info",
      ], { stdio: ["ignore", "pipe", "ignore"] });

      let buf = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) res.write("data: " + line + "\n\n");
        }
      });

      child.on("close", () => res.end());
      req.on("close", () => child.kill());
      return;
    }

    // SSE: foreground-app change stream. Emits `{bundleId, pid}` events
    // parsed from SpringBoard's "Setting process visibility to: Foreground"
    // log line. Filtering is done here (not in the browser) so the SSE stream
    // stays narrow and the client can listen without rate-limit concerns.
    if (url === base + "/appstate") {
      const states = readServeSimStates();
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

      const child: ChildProcess = spawn("xcrun", [
        "simctl", "spawn", udid, "log", "stream",
        "--style", "ndjson",
        "--level", "info",
        "--predicate",
        'process == "SpringBoard" AND eventMessage CONTAINS "Setting process visibility to: Foreground"',
      ], { stdio: ["ignore", "pipe", "ignore"] });

      let lastBundle = "";
      let hasEmitted = false;
      let closed = false;
      const emitApp = async (bundleId: string, pid?: number) => {
        if (!isUserFacingBundle(bundleId)) return;
        if (bundleId === lastBundle) return;
        lastBundle = bundleId;
        hasEmitted = true;
        const isReactNative = await detectReactNative(udid, bundleId);
        if (!closed) {
          res.write("data: " + JSON.stringify({ bundleId, pid, isReactNative }) + "\n\n");
        }
      };

      // The seed loses to any live log event — a SpringBoard log that fires
      // while the AX call is in flight is fresher than the AX snapshot.
      detectCurrentForegroundApp(udid, state.url).then((app) => {
        if (!app || closed || hasEmitted) return;
        lastBundle = app.bundleId;
        hasEmitted = true;
        res.write("data: " + JSON.stringify(app) + "\n\n");
      });

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
      });

      child.on("close", () => res.end());
      req.on("close", () => {
        closed = true;
        child.kill();
      });
      return;
    }

    // Not ours — pass through
    if (next) next();
  };
}
