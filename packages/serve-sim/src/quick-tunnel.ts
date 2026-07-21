import { randomBytes, timingSafeEqual } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "http";
import { delimiter, join } from "path";
import type { Socket } from "net";
import type { SimMiddleware } from "./middleware";
import { STATE_DIR, type ServeSimDeviceState } from "./state";

const ACCESS_COOKIE = "serve_sim_access";
const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
export const QUICK_TUNNEL_STATE_FILE = join(STATE_DIR, "tunnel.json");
export const QUICK_TUNNEL_LOG_FILE = join(STATE_DIR, "tunnel.log");

export interface QuickTunnel {
  url: string;
  child: ChildProcess;
}

export interface QuickTunnelState {
  ownerPid: number;
  cloudflaredPid: number;
  port: number;
  publicUrl: string;
  localUrl: string;
  logFile: string;
  devices: string[];
  startedAt: string;
  launch?: QuickTunnelLaunchConfig;
}

export interface QuickTunnelLaunchConfig {
  devices: string[];
  port: number;
  portExplicit: boolean;
  codec: string | null;
  panes: string[] | null;
  fit: boolean;
  theme: string | null;
}

export type TunnelAccessDecision =
  | { type: "allow" }
  | {
      type: "redirect";
      status: 302;
      location: string;
      cookie: string;
    }
  | {
      type: "deny";
      status: 401 | 403;
      body: string;
    };

type TunnelRequest = Pick<IncomingMessage, "method" | "url" | "headers">;

/** Return one normalized value from a Node request header. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Compare access tokens without leaking a matching prefix through timing. */
function tokensMatch(actual: string | null | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Read a named value from a Cookie header without decoding unrelated cookies. */
function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

/** Read the protocol reported by the first forwarding hop. */
function forwardedProtocol(headers: IncomingHttpHeaders): string | undefined {
  return firstHeader(headers["x-forwarded-proto"])?.split(",", 1)[0]?.trim().toLowerCase();
}

/** Identify direct loopback traffic that did not arrive through a proxy. */
function isLoopbackRequest(request: TunnelRequest): boolean {
  if (forwardedProtocol(request.headers) !== undefined) return false;
  const host = firstHeader(request.headers.host);
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" ||
      hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Require browser control requests to originate from their exact request host. */
function requestOriginMatchesHost(request: TunnelRequest): boolean {
  const origin = firstHeader(request.headers.origin);
  if (!origin) return true;
  const host = firstHeader(request.headers.host);
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.host !== host) return false;
    const protocol = forwardedProtocol(request.headers);
    return !protocol || parsed.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

/** Create the per-owner 256-bit credential embedded in the private launch URL. */
export function createTunnelAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Normalize the options that determine whether a detached tunnel can be reused. */
export function createQuickTunnelLaunchConfig(input: {
  devices: string[];
  port: number;
  portExplicit: boolean;
  codec?: string | null;
  panes?: readonly string[] | null;
  fit?: boolean;
  theme?: string | null;
}): QuickTunnelLaunchConfig {
  return {
    devices: [...input.devices],
    port: input.port,
    portExplicit: input.portExplicit,
    codec: input.codec ?? null,
    panes: input.panes ? [...input.panes] : null,
    fit: input.fit ?? false,
    theme: input.theme ?? null,
  };
}

/** Validate launch metadata loaded from the persisted tunnel state file. */
function validQuickTunnelLaunchConfig(value: unknown): value is QuickTunnelLaunchConfig {
  if (!value || typeof value !== "object") return false;
  const launch = value as Partial<QuickTunnelLaunchConfig>;
  return Array.isArray(launch.devices) &&
    launch.devices.every((device) => typeof device === "string") &&
    Number.isSafeInteger(launch.port) &&
    (launch.port ?? 0) > 0 &&
    typeof launch.portExplicit === "boolean" &&
    (launch.codec === null || typeof launch.codec === "string") &&
    (launch.panes === null || (
      Array.isArray(launch.panes) &&
      launch.panes.every((pane) => typeof pane === "string")
    )) &&
    typeof launch.fit === "boolean" &&
    (launch.theme === null || typeof launch.theme === "string");
}

/** Check whether live tunnel state represents the exact requested launch. */
export function quickTunnelLaunchMatches(
  state: Pick<QuickTunnelState, "launch">,
  requested: QuickTunnelLaunchConfig,
): boolean {
  const launch = state.launch;
  if (!launch) return false;
  const launchPanes = launch.panes;
  const requestedPanes = requested.panes;
  return launch.port === requested.port &&
    launch.portExplicit === requested.portExplicit &&
    launch.codec === requested.codec &&
    launch.fit === requested.fit &&
    launch.theme === requested.theme &&
    launch.devices.length === requested.devices.length &&
    launch.devices.every((device, index) => device === requested.devices[index]) &&
    (launchPanes === null
      ? requestedPanes === null
      : requestedPanes !== null &&
        launchPanes.length === requestedPanes.length &&
        launchPanes.every((pane, index) => pane === requestedPanes[index]));
}

const SIMULATOR_BOOT_TIMEOUT_MS = 60_000;
const QUICK_TUNNEL_READY_TIMEOUT_MS = 30_000;
const DETACHED_STARTUP_GRACE_MS = 15_000;

/** Budget sequential simulator boots, Quick Tunnel readiness, and launcher grace. */
export function detachedTunnelStartupTimeoutMs(deviceCount: number): number {
  return Math.max(1, deviceCount) * SIMULATOR_BOOT_TIMEOUT_MS +
    QUICK_TUNNEL_READY_TIMEOUT_MS +
    DETACHED_STARTUP_GRACE_MS;
}

type KillProcess = (pid: number, signal: NodeJS.Signals | number) => boolean;

/** Stop a detached launch and every child that inherited its process group. */
export function stopDetachedProcessGroup(
  pid: number,
  signal: NodeJS.Signals | number = "SIGTERM",
  killProcess: KillProcess = (target, targetSignal) => process.kill(target, targetSignal),
): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    killProcess(-pid, signal);
  } catch {
    try { killProcess(pid, signal); } catch {}
  }
}

/** Read and validate the persisted detached tunnel state. */
export function readQuickTunnelState(): QuickTunnelState | null {
  try {
    const state = JSON.parse(readFileSync(QUICK_TUNNEL_STATE_FILE, "utf-8")) as QuickTunnelState;
    if (
      !Number.isSafeInteger(state.ownerPid) ||
      state.ownerPid <= 0 ||
      !Number.isSafeInteger(state.cloudflaredPid) ||
      state.cloudflaredPid <= 0 ||
      !Number.isSafeInteger(state.port) ||
      state.port <= 0 ||
      typeof state.publicUrl !== "string" ||
      typeof state.localUrl !== "string" ||
      typeof state.logFile !== "string" ||
      !Array.isArray(state.devices) ||
      !state.devices.every((device) => typeof device === "string") ||
      typeof state.startedAt !== "string" ||
      (state.launch !== undefined && !validQuickTunnelLaunchConfig(state.launch))
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

/** Atomically persist owner-only detached tunnel state. */
export function writeQuickTunnelState(state: QuickTunnelState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tempFile = `${QUICK_TUNNEL_STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(tempFile, 0o600);
  renameSync(tempFile, QUICK_TUNNEL_STATE_FILE);
}

/** Remove tunnel state, optionally only when it still belongs to an owner PID. */
export function clearQuickTunnelState(ownerPid?: number): void {
  if (ownerPid !== undefined && readQuickTunnelState()?.ownerPid !== ownerPid) return;
  try { unlinkSync(QUICK_TUNNEL_STATE_FILE); } catch {}
}

/** Confirm runtime ownership before a controller signals a tunnel owner PID. */
export function quickTunnelMatchesDeviceStates(
  tunnel: QuickTunnelState,
  states: ServeSimDeviceState[],
): boolean {
  return tunnel.devices.length > 0 && tunnel.devices.every((device) => states.some((state) => (
    state.device === device &&
    state.pid === tunnel.ownerPid &&
    state.port === tunnel.port
  )));
}

/**
 * Exchange the unguessable launch URL for a host-only browser cookie. Quick
 * Tunnels do not provide authentication, and serve-sim's preview can execute
 * simulator-management commands on the host.
 */
export function authorizeTunnelRequest(
  request: TunnelRequest,
  expectedToken: string,
  options: { allowTokenExchange?: boolean; allowLoopback?: boolean } = {},
): TunnelAccessDecision {
  const url = new URL(request.url ?? "/", "http://serve-sim.local");
  const queryToken = url.searchParams.get("token");
  const allowTokenExchange = options.allowTokenExchange ?? true;

  if (
    allowTokenExchange &&
    request.method === "GET" &&
    tokensMatch(queryToken, expectedToken)
  ) {
    url.searchParams.delete("token");
    const secure = forwardedProtocol(request.headers) === "https";
    const cookie = [
      `${ACCESS_COOKIE}=${expectedToken}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      "Max-Age=86400",
      secure ? "Secure" : "",
    ].filter(Boolean).join("; ");
    return {
      type: "redirect",
      status: 302,
      location: `${url.pathname}${url.search}`,
      cookie,
    };
  }

  if (options.allowLoopback && isLoopbackRequest(request)) {
    return { type: "allow" };
  }

  const cookie = firstHeader(request.headers.cookie);
  if (!tokensMatch(cookieValue(cookie, ACCESS_COOKIE), expectedToken)) {
    return {
      type: "deny",
      status: 401,
      body: "Unauthorized. Use the complete private URL printed by serve-sim.\n",
    };
  }

  // A sibling trycloudflare.com page is considered same-site by browsers.
  // Check the exact origin as well so it cannot drive host commands or open a
  // simulator-control WebSocket with the host-only cookie.
  if (!requestOriginMatchesHost(request)) {
    return { type: "deny", status: 403, body: "Forbidden origin.\n" };
  }

  return { type: "allow" };
}

/** Write a redirect or authorization error to an HTTP response. */
function writeHttpDecision(res: ServerResponse, decision: Exclude<TunnelAccessDecision, { type: "allow" }>): void {
  const commonHeaders = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  if (decision.type === "redirect") {
    res.writeHead(decision.status, {
      ...commonHeaders,
      Location: decision.location,
      "Set-Cookie": decision.cookie,
    });
    res.end();
    return;
  }
  res.writeHead(decision.status, {
    ...commonHeaders,
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(decision.body);
}

/** Reject an unauthorized WebSocket upgrade with a complete HTTP response. */
function rejectUpgrade(socket: Socket, decision: Exclude<TunnelAccessDecision, { type: "allow" }>): void {
  const status = decision.type === "redirect" ? 401 : decision.status;
  const body = decision.type === "redirect"
    ? "Unauthorized. Open the private URL in a browser before connecting.\n"
    : decision.body;
  const reason = status === 403 ? "Forbidden" : "Unauthorized";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    "Cache-Control: no-store\r\n" +
    "Connection: close\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
    body,
  );
}

/** Keep the tunnel access gate CLI-internal while preserving middleware APIs. */
export function protectTunnelMiddleware(
  middleware: SimMiddleware,
  accessToken: string,
): SimMiddleware {
  const protectedMiddleware = (async (req, res, next) => {
    const decision = authorizeTunnelRequest(req, accessToken, { allowLoopback: true });
    if (decision.type !== "allow") {
      writeHttpDecision(res, decision);
      return;
    }
    return middleware(req, res, next);
  }) as SimMiddleware;

  protectedMiddleware.handleUpgrade = (req, socket, head) => {
    const decision = authorizeTunnelRequest(req, accessToken, {
      allowLoopback: true,
      allowTokenExchange: false,
    });
    if (decision.type !== "allow") {
      rejectUpgrade(socket, decision);
      return;
    }
    middleware.handleUpgrade(req, socket, head);
  };
  return protectedMiddleware;
}

/** Extract the first Quick Tunnel hostname emitted by cloudflared. */
export function extractQuickTunnelUrl(output: string): string | null {
  return output.match(QUICK_TUNNEL_URL_RE)?.[0] ?? null;
}

/** Locate an installed cloudflared executable on PATH. */
export function findCloudflared(): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "cloudflared");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Start cloudflared and resolve once it emits a usable Quick Tunnel URL. */
export function startQuickTunnel(
  cloudflaredPath: string,
  originUrl: string,
  logFile: string,
  options: { onSpawn?: (child: ChildProcess) => void } = {},
): Promise<QuickTunnel> {
  return new Promise((resolve, reject) => {
    // /dev/null deliberately bypasses a user-level config.yml, which
    // Cloudflare documents as incompatible with Quick Tunnels.
    const child = spawn(cloudflaredPath, [
      "tunnel",
      "--config", "/dev/null",
      "--no-autoupdate",
      "--url", originUrl,
      "--loglevel", "info",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    options.onSpawn?.(child);

    let settled = false;
    let diagnostics = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Timed out waiting for a Quick Tunnel URL.\n${diagnostics.trim()}`));
    }, QUICK_TUNNEL_READY_TIMEOUT_MS);

    const consume = (chunk: Buffer | string) => {
      const text = chunk.toString();
      try { appendFileSync(logFile, text); } catch {}
      diagnostics = (diagnostics + text).slice(-16_000);
      if (settled) return;
      const url = extractQuickTunnelUrl(diagnostics);
      if (!url) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ url, child });
    };

    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(
        `cloudflared exited before creating a Quick Tunnel (code=${code}, signal=${signal}).\n${diagnostics.trim()}`,
      ));
    });
  });
}
