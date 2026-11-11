/**
 * Shared pieces of the persistent control process: which commands it may
 * run, where its socket lives, the wire framing, and the fingerprint that
 * decides whether a warm worker matches the caller.
 *
 * This file is imported by the tiny bin entry (src/bin.ts), so it must only
 * pull in node builtins — anything heavier defeats the point.
 */
import { createHash } from "crypto";
import { lstatSync, readlinkSync, realpathSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";

const CONTROL_PROTOCOL = 2;
/** argv[2] marker for the daemon process (visible in `ps`). */
export const CONTROL_DAEMON_ARG = "__control-daemon";
/** Set on pre-warmed worker processes; stripped before the command runs. */
export const CONTROL_ROLE_ENV = "SERVE_SIM_CONTROL_ROLE";
/** `0`/`off` disables the control process; `1`/`on` auto-starts even in CI. */
const CONTROL_ENV = "SERVE_SIM_CONTROL";
/** Quiet period before the daemon exits on its own (ms). */
export const CONTROL_IDLE_ENV = "SERVE_SIM_CONTROL_IDLE_MS";
/** Override the socket/pid directory (tests, unusual TMPDIRs). @lintignore Exported for tests. */
export const CONTROL_DIR_ENV = "SERVE_SIM_CONTROL_DIR";
/** How long a caller waits for the daemon to hand it a worker (ms). */
export const CONTROL_ACCEPT_ENV = "SERVE_SIM_CONTROL_ACCEPT_MS";
const DEFAULT_ACCEPT_MS = 1000;
const DEFAULT_IDLE_MS = 5 * 60_000;
/** Warm workers kept ready; each is single-use, then replaced. */
export const DEFAULT_POOL_SIZE = 2;

/**
 * Short, one-shot commands that only talk to a running preview server and
 * print a result. Anything that starts servers, injects into apps, records,
 * reads stdin or runs an interactive shell keeps running in-process.
 */
const DISPATCHABLE_COMMANDS: ReadonlySet<string> = new Set([
  "tap",
  "gesture",
  "settle",
  "button",
  "type",
  "paste",
  "rotate",
  "fold",
  "ca-debug",
  "memory-warning",
  "event-log",
  "ax",
  "buffer",
]);

const ROOT_INFO_FLAGS = new Set(["--help", "-h", "--version", "-v"]);

/**
 * Whether `args` (argv after the script) may run in a warm worker. `cwd` is
 * the caller's working directory, used to resolve relative `--file` paths.
 */
export function isDispatchable(args: readonly string[], cwd?: string): boolean {
  const [first] = args;
  if (first == null) return false; // bare `serve-sim` starts the preview server
  if (args.length === 1 && ROOT_INFO_FLAGS.has(first)) return true;
  if (first === "help") return args.length <= 2;
  if (!DISPATCHABLE_COMMANDS.has(first)) return false;
  // stdin is not forwarded to workers (nor are its /dev aliases).
  if (args.includes("--stdin")) return false;
  if (readsDevFile(args, cwd)) return false;
  return true;
}

/**
 * `--file /dev/stdin`, `--file=/dev/fd/0` and friends read the caller's fds.
 * Relative paths (`../../dev/stdin`) and symlinks into /dev count too.
 */
export function readsDevFile(args: readonly string[], cwd?: string): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = a === "--file" ? args[i + 1] : a.startsWith("--file=") ? a.slice("--file=".length) : null;
    if (value == null || value === "") continue;
    if (!isAbsolute(value) && cwd == null) continue;
    if (intoDev(isAbsolute(value) ? resolve(value) : resolve(cwd!, value))) return true;
  }
  return false;
}

/**
 * Whether `path` lands in /dev/, following symlinks one hop at a time
 * (realpath on /dev/stdin itself resolves fd 0, which can fail or vary).
 */
function intoDev(path: string): boolean {
  let p = path;
  for (let hop = 0; hop < 32; hop++) {
    if (p.startsWith("/dev/")) return true;
    try {
      p = join(realpathSync(dirname(p)), basename(p));
      if (p.startsWith("/dev/")) return true;
      if (!lstatSync(p).isSymbolicLink()) return false;
      p = resolve(dirname(p), readlinkSync(p));
    } catch {
      return false;
    }
  }
  return false;
}

export type ControlMode = "off" | "use" | "auto";

/**
 * off: never touch the control process. use: dispatch to one that is already
 * running but never start one (the default under CI, so jobs don't leave a
 * daemon behind). auto: dispatch, and start one in the background if absent.
 */
export function controlMode(env: NodeJS.ProcessEnv): ControlMode {
  const raw = env[CONTROL_ENV]?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return "off";
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return "auto";
  const ci = env.CI?.trim().toLowerCase();
  if (ci && ci !== "0" && ci !== "false") return "use";
  return "auto";
}

export function parseAcceptMs(raw: string | undefined): number {
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ACCEPT_MS;
}

/**
 * Node runtime settings a warm worker can't adopt after it has started:
 * they shape how node itself boots (preloads, inspector, CA store, proxy).
 * They are stripped from the daemon and its workers, and a caller that sets
 * any of them runs in-process.
 */
const NODE_RUNTIME_ENV = ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY"] as const;

export function withoutNodeRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of NODE_RUNTIME_ENV) delete out[key];
  return out;
}

/**
 * Env markers of an OS sandbox around the caller (Codex's seatbelt, Claude
 * Code's sandbox runtime). A worker can't enter the caller's sandbox, and a
 * daemon started inside one would confine everyone else's commands, so
 * these callers run in-process and never start a daemon.
 */
const SANDBOX_ENV = ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "SANDBOX_RUNTIME"] as const;

export function sandboxMarker(env: NodeJS.ProcessEnv): string | null {
  for (const key of SANDBOX_ENV) if (env[key]) return key;
  return null;
}

/** The first runtime setting the caller has that a worker can't honor. */
export function nodeRuntimeOverride(env: NodeJS.ProcessEnv, execArgv: readonly string[]): string | null {
  for (const key of NODE_RUNTIME_ENV) if (env[key]) return key;
  return execArgv.length > 0 ? "execArgv" : null;
}

export function parseIdleMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_IDLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 100 ? Math.floor(n) : DEFAULT_IDLE_MS;
}

export interface ControlPaths {
  dir: string;
  socket: string;
  pidFile: string;
  /** Written when workers can't load, so callers stop respawning a daemon. */
  failFile: string;
}

/**
 * One daemon per (bin file, node binary, HOME): different installs or node
 * versions never share warm workers.
 */
export function controlPaths(opts: {
  binFile: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
}): ControlPaths {
  // Per-uid so another user on a shared /tmp can't pre-create the directory.
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const dir = opts.env[CONTROL_DIR_ENV] || join(tmpdir(), uid == null ? "serve-sim-control" : `serve-sim-control-${uid}`);
  const id = createHash("sha256")
    .update(`${opts.binFile}\0${opts.execPath}\0${opts.env.HOME ?? homedir()}`)
    .digest("hex")
    .slice(0, 12);
  return {
    dir,
    socket: join(dir, `control-${id}.sock`),
    pidFile: join(dir, `control-${id}.json`),
    failFile: join(dir, `control-${id}.failed`),
  };
}

/** sun_path is 104 bytes on macOS, including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/**
 * Why `dir` can't hold the control socket, or null if it is a real
 * directory owned by us that nobody else can write to. The client sends its
 * whole environment over the socket, so it must be ours.
 */
export function unsafeControlDir(dir: string): string | null {
  let st;
  try {
    st = lstatSync(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isDirectory()) return "not a directory";
  const uid = currentUid();
  if (uid != null && st.uid !== uid) return `owned by uid ${st.uid}`;
  if ((st.mode & 0o077) !== 0) return `mode ${(st.mode & 0o777).toString(8)} is group/other accessible`;
  return null;
}

/** Why `socket` isn't a socket we own ("missing" when absent), or null. */
export function unsafeControlSocket(socket: string): string | null {
  let st;
  try {
    st = lstatSync(socket);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isSocket()) return "not a socket";
  const uid = currentUid();
  if (uid != null && st.uid !== uid) return `owned by uid ${st.uid}`;
  return null;
}

/**
 * What a warm worker baked in at load time. The main bundle reads HOME and
 * TMPDIR into module constants and `debug` reads DEBUG on import, so a caller
 * whose values differ must run in-process. The mtimes catch a rebuilt dist
 * under a still-running daemon.
 */
export interface ControlFingerprint {
  protocol: number;
  execPath: string;
  home: string;
  tmpdir: string;
  debug: string;
  binMtimeMs: number;
  mainMtimeMs: number;
}

function mtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

export function controlFingerprint(opts: {
  binFile: string;
  mainFile: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
}): ControlFingerprint {
  return {
    protocol: CONTROL_PROTOCOL,
    execPath: opts.execPath,
    home: opts.env.HOME ?? "",
    tmpdir: opts.env.TMPDIR ?? "",
    debug: opts.env.DEBUG ?? "",
    binMtimeMs: mtimeMs(opts.binFile),
    mainMtimeMs: mtimeMs(opts.mainFile),
  };
}

/** First differing field, or null when the worker matches the caller. */
export function fingerprintMismatch(
  daemon: ControlFingerprint,
  caller: ControlFingerprint,
): keyof ControlFingerprint | null {
  for (const key of Object.keys(daemon) as (keyof ControlFingerprint)[]) {
    if (daemon[key] !== caller[key]) return key;
  }
  return null;
}

/** A rebuilt dist means the daemon itself is stale and should go away. */
export function isStaleBuild(field: keyof ControlFingerprint | null): boolean {
  return field === "binMtimeMs" || field === "mainMtimeMs" || field === "protocol";
}

// ─── Wire framing ────────────────────────────────────────────────────────
// [type u8][length u32 BE][payload]. JSON frames carry control messages;
// stdout/stderr frames carry raw command output bytes.

/** @lintignore Exported for tests. */
export const FRAME_JSON = 0x4a; // J
export const FRAME_STDOUT = 0x4f; // O
export const FRAME_STDERR = 0x45; // E
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(type: number, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export function encodeJson(message: ControlMessage): Buffer {
  return encodeFrame(FRAME_JSON, JSON.stringify(message));
}

export interface Frame {
  type: number;
  payload: Buffer;
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer | string): Frame[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);
    const frames: Frame[] = [];
    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) throw new Error(`control frame too large (${length} bytes)`);
      if (this.buffer.length < 5 + length) break;
      frames.push({
        type: this.buffer.readUInt8(0),
        payload: this.buffer.subarray(5, 5 + length),
      });
      this.buffer = this.buffer.subarray(5 + length);
    }
    return frames;
  }
}

export interface StreamTty {
  isTTY: boolean;
  columns?: number;
}

export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

export type ControlMessage =
  | {
      t: "run";
      fingerprint: ControlFingerprint;
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      tty: { stdout: StreamTty; stderr: StreamTty };
      /** The caller's stdout and stderr are the same file (e.g. `2>&1`). */
      sharedOutput?: boolean;
      /** The caller's umask, so files the command writes get its modes. */
      umask?: number;
    }
  // Two-phase start: the daemon replies `accepted` once it holds a worker
  // for the caller, and only hands it the command after the caller's `go`.
  | { t: "go" }
  | { t: "signal"; signal: ForwardedSignal }
  | { t: "ping" }
  | { t: "stop" }
  | { t: "accepted" }
  | { t: "bypass"; reason: string }
  | { t: "exit"; code: number | null; signal: string | null }
  | { t: "pong"; status: ControlStatus }
  /** `busy`: commands still running; the daemon exits once they finish. */
  | { t: "stopping"; busy?: number };

export interface ControlStatus {
  pid: number;
  startedAt: number;
  lastActiveAt: number;
  idleMs: number;
  warm: number;
  warming: number;
  busy: number;
  served: number;
  socket: string;
}

export function parseJsonFrame(frame: Frame): ControlMessage | null {
  if (frame.type !== FRAME_JSON) return null;
  try {
    const value = JSON.parse(frame.payload.toString("utf8")) as ControlMessage;
    return value && typeof value === "object" && typeof value.t === "string" ? value : null;
  } catch {
    return null;
  }
}

// ─── Deferred main ───────────────────────────────────────────────────────
// A warm worker imports the full CLI bundle ahead of time; the bundle hands
// its entry point back instead of parsing argv right away.

const DEFER_KEY = Symbol.for("serve-sim.control.defer-main");
type DeferredMain = () => Promise<unknown>;

/** Called by the CLI bundle in place of `await main()`. */
export async function runCliMain(main: DeferredMain): Promise<void> {
  const hook = (globalThis as Record<symbol, unknown>)[DEFER_KEY];
  if (typeof hook === "function") {
    (hook as (main: DeferredMain) => void)(main);
    return;
  }
  await main();
}

export function deferCliMain(capture: (main: DeferredMain) => void): void {
  (globalThis as Record<symbol, unknown>)[DEFER_KEY] = capture;
}
