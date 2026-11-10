/**
 * Shared pieces of the persistent control process: which commands it may
 * run, where its socket lives, the wire framing, and the fingerprint that
 * decides whether a warm worker matches the caller.
 *
 * This file is imported by the tiny bin entry (src/bin.ts), so it must only
 * pull in node builtins — anything heavier defeats the point.
 */
import { createHash } from "crypto";
import { statSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const CONTROL_PROTOCOL = 1;
/** argv[2] marker for the daemon process (visible in `ps`). */
export const CONTROL_DAEMON_ARG = "__control-daemon";
/** Set on pre-warmed worker processes; stripped before the command runs. */
export const CONTROL_ROLE_ENV = "SERVE_SIM_CONTROL_ROLE";
/** `0`/`off` disables the control process; `1`/`on` auto-starts even in CI. */
const CONTROL_ENV = "SERVE_SIM_CONTROL";
/** Quiet period before the daemon exits on its own (ms). */
export const CONTROL_IDLE_ENV = "SERVE_SIM_CONTROL_IDLE_MS";
/** Override the socket/pid directory (tests, unusual TMPDIRs). */
export const CONTROL_DIR_ENV = "SERVE_SIM_CONTROL_DIR";
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

/** Whether `args` (argv after the script) may run in a warm worker. */
export function isDispatchable(args: readonly string[]): boolean {
  const [first] = args;
  if (first == null) return false; // bare `serve-sim` starts the preview server
  if (args.length === 1 && ROOT_INFO_FLAGS.has(first)) return true;
  if (first === "help") return args.length <= 2;
  if (!DISPATCHABLE_COMMANDS.has(first)) return false;
  // stdin is not forwarded to workers.
  if (args.includes("--stdin")) return false;
  return true;
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

export function parseIdleMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_IDLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 100 ? Math.floor(n) : DEFAULT_IDLE_MS;
}

export interface ControlPaths {
  dir: string;
  socket: string;
  pidFile: string;
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
  const dir = opts.env[CONTROL_DIR_ENV] || join(tmpdir(), "serve-sim");
  const id = createHash("sha256")
    .update(`${opts.binFile}\0${opts.execPath}\0${opts.env.HOME ?? homedir()}`)
    .digest("hex")
    .slice(0, 12);
  return {
    dir,
    socket: join(dir, `control-${id}.sock`),
    pidFile: join(dir, `control-${id}.json`),
  };
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
    }
  | { t: "signal"; signal: ForwardedSignal }
  | { t: "ping" }
  | { t: "stop" }
  | { t: "accepted" }
  | { t: "bypass"; reason: string }
  | { t: "exit"; code: number | null; signal: string | null }
  | { t: "pong"; status: ControlStatus }
  | { t: "stopping" };

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
