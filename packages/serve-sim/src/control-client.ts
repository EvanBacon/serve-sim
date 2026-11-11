/**
 * Thin client for the persistent control process, plus `serve-sim control
 * start|stop|status`. Runs inside the tiny bin entry, so node builtins only.
 *
 * The daemon replies `accepted` once it holds a warm worker for the call,
 * and only hands the worker the command after the client answers `go`.
 * Every failure before `go` therefore means "run it in-process instead":
 * nothing has run yet, so a missing, stale or wedged daemon only costs a
 * failed connect. After `go` the client never falls back.
 */
import { execFileSync, spawn } from "child_process";
import { existsSync, fstatSync, readFileSync, unlinkSync } from "fs";
import { createConnection } from "net";
import {
  CONTROL_DAEMON_ARG,
  FORWARDED_SIGNALS,
  FRAME_STDERR,
  FRAME_STDOUT,
  FrameDecoder,
  MAX_SOCKET_PATH_BYTES,
  controlFingerprint,
  controlMode,
  controlPaths,
  encodeJson,
  isDispatchable,
  nodeRuntimeOverride,
  parseJsonFrame,
  sandboxMarker,
  unsafeControlDir,
  unsafeControlSocket,
  withoutNodeRuntimeEnv,
  type ControlFingerprint,
  type ControlPaths,
  type ControlStatus,
  type ForwardedSignal,
} from "./control-protocol";
import { pingSocket } from "./control-daemon";

export interface ControlContext {
  binFile: string;
  mainFile: string;
  execPath: string;
  /** The caller's node flags; workers can't adopt them. */
  execArgv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Read lazily: the caller's cwd may have been deleted. */
  cwd: () => string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  /** How long to wait for the daemon to accept before running in-process. */
  acceptTimeoutMs?: number;
  /** Test hook: called right after each client frame is written. */
  afterWrite?: (t: string) => void;
}

export type DispatchResult =
  | { kind: "bypass"; reason: string }
  | { kind: "done"; code: number | null; signal: NodeJS.Signals | null };

function pathsFor(ctx: ControlContext): ControlPaths {
  return controlPaths({ binFile: ctx.binFile, execPath: ctx.execPath, env: ctx.env });
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Whether fds 1 and 2 are the same open file (`2>&1`, one pty). */
function sameOutputFile(): boolean {
  try {
    const out = fstatSync(1);
    const err = fstatSync(2);
    return out.dev === err.dev && out.ino === err.ino;
  } catch {
    return false;
  }
}

/** Don't retry a daemon whose workers couldn't load this build for a while. */
const FAILED_BACKOFF_MS = 10 * 60_000;

interface FailRecord {
  at: number;
  binMtimeMs: number;
  mainMtimeMs: number;
  reason?: string;
}

function readFailRecord(file: string): FailRecord | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as FailRecord;
    return typeof v.at === "number" ? v : null;
  } catch {
    return null;
  }
}

function recentlyFailed(paths: ControlPaths, fp: ControlFingerprint): boolean {
  const rec = readFailRecord(paths.failFile);
  return (
    rec != null &&
    Date.now() - rec.at < FAILED_BACKOFF_MS &&
    rec.binMtimeMs === fp.binMtimeMs &&
    rec.mainMtimeMs === fp.mainMtimeMs
  );
}

/** Start a detached daemon and return immediately. */
function spawnDaemon(ctx: ControlContext): void {
  try {
    const child = spawn(ctx.execPath, [ctx.binFile, CONTROL_DAEMON_ARG], {
      cwd: "/",
      detached: true,
      stdio: "ignore",
      env: withoutNodeRuntimeEnv(ctx.env),
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/** Why the control socket can't be used, or null. "missing" means start one. */
function unusableSocket(paths: ControlPaths): string | null {
  if (Buffer.byteLength(paths.socket) > MAX_SOCKET_PATH_BYTES) return "socket path too long";
  const dir = unsafeControlDir(paths.dir);
  if (dir) return dir === "missing" ? "missing" : `control dir ${dir}`;
  const sock = unsafeControlSocket(paths.socket);
  if (sock) return sock === "missing" ? "missing" : `control socket ${sock}`;
  return null;
}

/**
 * Run `args` through the control process when possible. Resolves "bypass"
 * whenever the caller should run the command in-process.
 */
export function dispatchViaControl(args: string[], ctx: ControlContext): Promise<DispatchResult> {
  const bypass = (reason: string) => Promise.resolve<DispatchResult>({ kind: "bypass", reason });
  const mode = controlMode(ctx.env);
  if (mode === "off") return bypass("disabled");
  if (!isDispatchable(args)) return bypass("not dispatchable");
  const runtime = nodeRuntimeOverride(ctx.env, ctx.execArgv);
  if (runtime) return bypass(`caller sets ${runtime}`);
  const sandbox = sandboxMarker(ctx.env);
  if (sandbox) return bypass(`sandboxed (${sandbox})`);
  let cwd: string;
  try {
    cwd = ctx.cwd();
  } catch {
    return bypass("no cwd");
  }
  const paths = pathsFor(ctx);
  const fingerprint = controlFingerprint(ctx);
  const unusable = unusableSocket(paths);
  if (unusable === "missing") {
    if (mode === "auto" && !recentlyFailed(paths, fingerprint)) spawnDaemon(ctx);
    return bypass("not running");
  }
  if (unusable) return bypass(unusable);

  return new Promise((resolve) => {
    const conn = createConnection(paths.socket);
    const decoder = new FrameDecoder();
    // Once `go` is written the worker may be running: never fall back after.
    let committed = false;
    let settled = false;
    const signalHandlers = new Map<ForwardedSignal, () => void>();
    const send = (msg: Parameters<typeof encodeJson>[0]) => {
      conn.write(encodeJson(msg));
      ctx.afterWrite?.(msg.t);
    };

    const finish = (result: DispatchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(acceptTimer);
      for (const [sig, handler] of signalHandlers) process.off(sig, handler);
      conn.destroy();
      resolve(result);
    };
    const lost = (detail: string) => {
      ctx.stderr.write(`serve-sim: lost the control process mid-command (${detail})\n`);
      finish({ kind: "done", code: 1, signal: null });
    };
    // Covers connect + waiting for a worker. It can only fire before `go`:
    // the `accepted` handler clears it and sends `go` in the same tick.
    const acceptTimer = setTimeout(
      () => finish({ kind: "bypass", reason: "accept timeout" }),
      ctx.acceptTimeoutMs ?? 1000,
    );

    conn.on("error", (error: NodeJS.ErrnoException) => {
      if (committed) return lost(error.code ?? error.message);
      if (mode === "auto" && (error.code === "ENOENT" || error.code === "ECONNREFUSED") && !recentlyFailed(paths, fingerprint)) spawnDaemon(ctx);
      finish({ kind: "bypass", reason: error.code ?? "connect failed" });
    });
    conn.on("close", () => {
      if (settled) return;
      if (committed) lost("closed");
      else finish({ kind: "bypass", reason: "closed before accept" });
    });
    conn.on("connect", () => {
      send({
        t: "run",
        fingerprint,
        argv: args,
        cwd,
        env: stringEnv(ctx.env),
        tty: {
          stdout: { isTTY: ctx.stdout.isTTY === true, columns: ctx.stdout.columns },
          stderr: { isTTY: ctx.stderr.isTTY === true, columns: ctx.stderr.columns },
        },
        sharedOutput: sameOutputFile(),
        umask: process.umask(),
      });
    });
    conn.on("data", (chunk) => {
      if (settled) return;
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        conn.destroy();
        return;
      }
      for (const frame of frames) {
        if (settled) return;
        if (frame.type === FRAME_STDOUT) {
          ctx.stdout.write(frame.payload);
          continue;
        }
        if (frame.type === FRAME_STDERR) {
          ctx.stderr.write(frame.payload);
          continue;
        }
        const msg = parseJsonFrame(frame);
        if (!msg) continue;
        // The daemon only says bypass before it handed the job to a worker.
        if (msg.t === "bypass") finish({ kind: "bypass", reason: msg.reason });
        else if (msg.t === "accepted" && !committed) {
          clearTimeout(acceptTimer);
          committed = true;
          send({ t: "go" });
          // From here the worker owns the command: forward signals to it.
          for (const sig of FORWARDED_SIGNALS) {
            const handler = () => send({ t: "signal", signal: sig });
            signalHandlers.set(sig, handler);
            process.on(sig, handler);
          }
        } else if (msg.t === "exit") {
          finish({ kind: "done", code: msg.code, signal: (msg.signal as NodeJS.Signals | null) ?? null });
        }
      }
    });
  });
}

// ─── serve-sim control start|stop|status ─────────────────────────────────

const CONTROL_USAGE = `Usage: serve-sim control [status|start|stop] [--json]

Persistent control process: keeps pre-warmed workers so short commands
(tap, type, button, ax, buffer, --help, ...) skip Node startup. Started
automatically on first use and exits after SERVE_SIM_CONTROL_IDLE_MS
(default 5 minutes) of quiet. SERVE_SIM_CONTROL=0 disables it; under CI it
is only used when already running unless SERVE_SIM_CONTROL=1.

  status   Show whether it is running (exit 1 if not)
  start    Start it if needed and wait until it answers (idempotent)
  stop     Stop it and clear stale socket/pid files (idempotent)`;

interface PidRecord {
  pid: number;
}

function readPidRecord(file: string): PidRecord | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as PidRecord;
    return typeof v.pid === "number" ? v : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function looksLikeDaemon(pid: number): boolean {
  try {
    const args = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 1000 });
    return args.includes(CONTROL_DAEMON_ARG);
  } catch {
    return false;
  }
}

/** Remove socket/pid files no live daemon is behind. */
async function clearStaleControlFiles(paths: ControlPaths): Promise<boolean> {
  if (await pingSocket(paths.socket)) return false;
  let cleared = false;
  if (existsSync(paths.socket)) {
    try {
      unlinkSync(paths.socket);
      cleared = true;
    } catch {}
  }
  const rec = readPidRecord(paths.pidFile);
  if (existsSync(paths.pidFile) && (!rec || !isAlive(rec.pid))) {
    try {
      unlinkSync(paths.pidFile);
      cleared = true;
    } catch {}
  }
  return cleared;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(25);
  }
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return waitFor(async () => (isAlive(pid) ? null : true), timeoutMs).then((v) => v === true);
}

/** Ask the daemon to stop; resolves with how many commands it is still running. */
function requestStop(socket: string): Promise<number> {
  return new Promise((resolve) => {
    const conn = createConnection(socket);
    const decoder = new FrameDecoder();
    let busy = 0;
    conn.on("connect", () => conn.write(encodeJson({ t: "stop" })));
    // Read the reply, or the socket never reaches end/close.
    conn.on("data", (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          const msg = parseJsonFrame(frame);
          if (msg?.t === "stopping" && typeof msg.busy === "number") busy = msg.busy;
        }
      } catch {}
    });
    conn.on("close", () => resolve(busy));
    conn.on("error", () => resolve(busy));
  });
}

function formatStatus(s: ControlStatus): string {
  const idleLeft = Math.max(0, s.idleMs - (Date.now() - s.lastActiveAt));
  return (
    `control process running (pid ${s.pid}): ${s.warm} warm, ${s.warming} warming, ${s.busy} busy, ` +
    `${s.served} served; idle exit in ${Math.ceil(idleLeft / 1000)}s\n  socket ${s.socket}`
  );
}

export async function controlCli(args: string[], ctx: ControlContext): Promise<number> {
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const verb = rest[0] ?? "status";
  const out = (line: string) => ctx.stdout.write(`${line}\n`);
  const paths = pathsFor(ctx);

  if (verb === "--help" || verb === "-h" || verb === "help" || rest.length > 1) {
    (rest.length > 1 ? ctx.stderr : ctx.stdout).write(`${CONTROL_USAGE}\n`);
    return rest.length > 1 ? 1 : 0;
  }
  const unsafeDir = unsafeControlDir(paths.dir);
  if (unsafeDir && unsafeDir !== "missing" && verb !== "start") {
    ctx.stderr.write(`serve-sim: ignoring control dir ${paths.dir}: ${unsafeDir}\n`);
    return 1;
  }
  if (verb === "status") {
    const status = unusableSocket(paths) ? null : await pingSocket(paths.socket);
    // A recent fail record is why commands aren't starting one.
    const failed = status ? null : readFailRecord(paths.failFile);
    const recent = failed && Date.now() - failed.at < FAILED_BACKOFF_MS ? failed : null;
    if (json) {
      out(
        JSON.stringify(
          status
            ? { running: true, ...status }
            : { running: false, socket: paths.socket, ...(recent ? { failed: { at: recent.at, reason: recent.reason ?? "" } } : {}) },
        ),
      );
    } else if (status) out(formatStatus(status));
    else if (recent) {
      const ago = Math.max(0, Math.round((Date.now() - recent.at) / 1000));
      const reason = recent.reason?.trim() ? `\n${recent.reason.trimEnd()}` : "";
      out(
        `control process not running: its workers failed to load the CLI ${ago}s ago, so commands run in-process ` +
          `and won't auto-start it for ${Math.ceil(FAILED_BACKOFF_MS / 60_000)} minutes; ` +
          `run \`serve-sim control start\` to retry${reason}`,
      );
    } else out("control process not running");
    return status ? 0 : 1;
  }
  if (verb === "start") {
    // Socket-level problems inside our own private dir are the daemon's to
    // clear; refuse only what it can't fix.
    const tooLong = Buffer.byteLength(paths.socket) > MAX_SOCKET_PATH_BYTES;
    if (tooLong || (unsafeDir && unsafeDir !== "missing")) {
      const why = tooLong
        ? `socket path ${paths.socket} is ${Buffer.byteLength(paths.socket)} bytes (max ${MAX_SOCKET_PATH_BYTES}); set SERVE_SIM_CONTROL_DIR to a shorter directory`
        : `${paths.dir} is ${unsafeDir}; it must be a directory owned by you with mode 0700`;
      ctx.stderr.write(`serve-sim: control process can't start: ${why}\n`);
      return 1;
    }
    let status = await pingSocket(paths.socket);
    const already = status != null;
    if (!status) {
      // An explicit start retries even after workers failed to load.
      try {
        unlinkSync(paths.failFile);
      } catch {}
      spawnDaemon(ctx);
      status = await waitFor(() => pingSocket(paths.socket), 5000);
      // Don't report success until a worker could actually load the CLI;
      // a daemon whose workers can't load writes its fail file and exits.
      if (status && status.warm === 0) {
        const ready = await waitFor(async () => {
          const s = await pingSocket(paths.socket);
          if (s) return s.warm > 0 ? s : null;
          return existsSync(paths.failFile) ? "failed" : null;
        }, 10_000);
        status = ready && ready !== "failed" ? ready : null;
      }
    }
    if (!status) {
      const failed = readFailRecord(paths.failFile);
      const detail = failed?.reason ? `: workers failed to load the CLI\n${failed.reason.trimEnd()}` : "";
      ctx.stderr.write(`serve-sim: control process did not start${detail}\n`);
      return 1;
    }
    if (json) out(JSON.stringify({ running: true, alreadyRunning: already, ...status }));
    else out(already ? `already running (pid ${status.pid})` : `started (pid ${status.pid})`);
    if (controlMode(ctx.env) === "off") {
      ctx.stderr.write("serve-sim: note: SERVE_SIM_CONTROL=0 is set, so commands won't use it\n");
    }
    return 0;
  }
  if (verb === "stop") {
    const status = await pingSocket(paths.socket);
    let pid: number | null = status?.pid ?? null;
    let stopped = false;
    /** Commands the daemon is letting finish before it exits. */
    let running = 0;
    if (status) {
      running = await requestStop(paths.socket);
      stopped = await waitForExit(status.pid, running > 0 ? 1000 : 5000);
    } else {
      // Alive but not answering (wedged or stopped): terminate it if the
      // pid really is our daemon, not a recycled pid.
      const rec = readPidRecord(paths.pidFile);
      if (rec && rec.pid !== process.pid && isAlive(rec.pid) && looksLikeDaemon(rec.pid)) {
        pid = rec.pid;
        try {
          process.kill(rec.pid, "SIGTERM");
        } catch {}
        stopped = await waitForExit(rec.pid, 3000);
      }
    }
    const cleared = await clearStaleControlFiles(paths);
    const wasRunning = pid != null;
    // Only report stopped once the process is really gone.
    const stopping = wasRunning && !stopped;
    if (json) {
      out(
        JSON.stringify({
          wasRunning,
          pid,
          stopped: wasRunning && stopped,
          ...(stopping ? { stopping: true, busy: running } : {}),
          clearedStale: cleared,
        }),
      );
    } else if (!wasRunning) out(cleared ? "not running (cleared stale files)" : "not running");
    else if (stopped) out(`stopped (pid ${pid})`);
    else if (running > 0) out(`stopping (pid ${pid}); waiting for ${running} running command(s) to finish`);
    else out(`stopping (pid ${pid}); it has not exited yet`);
    return 0;
  }
  ctx.stderr.write(`serve-sim: unknown control verb '${verb}'\n${CONTROL_USAGE}\n`);
  return 1;
}
