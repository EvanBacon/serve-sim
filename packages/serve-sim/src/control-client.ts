/**
 * Thin client for the persistent control process, plus `serve-sim control
 * start|stop|status`. Runs inside the tiny bin entry, so node builtins only.
 *
 * Every failure before the daemon has accepted a command means "run it
 * in-process instead", so a missing, stale or wedged daemon only costs a
 * failed connect.
 */
import { execFileSync, spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { createConnection } from "net";
import {
  CONTROL_DAEMON_ARG,
  FORWARDED_SIGNALS,
  FRAME_STDERR,
  FRAME_STDOUT,
  FrameDecoder,
  controlFingerprint,
  controlMode,
  controlPaths,
  encodeJson,
  isDispatchable,
  parseJsonFrame,
  type ControlPaths,
  type ControlStatus,
  type ForwardedSignal,
} from "./control-protocol";
import { pingSocket } from "./control-daemon";

export interface ControlContext {
  binFile: string;
  mainFile: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  /** How long to wait for the daemon to accept before running in-process. */
  acceptTimeoutMs?: number;
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

/** Start a detached daemon and return immediately. */
function spawnDaemon(ctx: ControlContext): void {
  try {
    const child = spawn(ctx.execPath, [ctx.binFile, CONTROL_DAEMON_ARG], {
      cwd: "/",
      detached: true,
      stdio: "ignore",
      env: ctx.env,
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/**
 * Run `args` through the control process when possible. Resolves "bypass"
 * whenever the caller should run the command in-process.
 */
export function dispatchViaControl(args: string[], ctx: ControlContext): Promise<DispatchResult> {
  const mode = controlMode(ctx.env);
  if (mode === "off") return Promise.resolve({ kind: "bypass", reason: "disabled" });
  if (!isDispatchable(args)) return Promise.resolve({ kind: "bypass", reason: "not dispatchable" });
  const { socket } = pathsFor(ctx);
  // sun_path is 104 bytes on macOS; a deep TMPDIR can't host the socket.
  if (Buffer.byteLength(socket) > 103) return Promise.resolve({ kind: "bypass", reason: "socket path too long" });

  return new Promise((resolve) => {
    const conn = createConnection(socket);
    const decoder = new FrameDecoder();
    let accepted = false;
    let settled = false;
    const signalHandlers = new Map<ForwardedSignal, () => void>();

    const finish = (result: DispatchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(acceptTimer);
      for (const [sig, handler] of signalHandlers) process.off(sig, handler);
      conn.destroy();
      resolve(result);
    };
    const acceptTimer = setTimeout(
      () => finish({ kind: "bypass", reason: "accept timeout" }),
      ctx.acceptTimeoutMs ?? 1000,
    );

    conn.on("error", (error: NodeJS.ErrnoException) => {
      if (accepted) {
        ctx.stderr.write(`serve-sim: lost the control process mid-command (${error.code ?? error.message})\n`);
        finish({ kind: "done", code: 1, signal: null });
        return;
      }
      if (mode === "auto" && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) spawnDaemon(ctx);
      finish({ kind: "bypass", reason: error.code ?? "connect failed" });
    });
    conn.on("close", () => {
      if (settled) return;
      if (!accepted) finish({ kind: "bypass", reason: "closed before accept" });
      else {
        ctx.stderr.write("serve-sim: control process exited mid-command\n");
        finish({ kind: "done", code: 1, signal: null });
      }
    });
    conn.on("connect", () => {
      conn.write(
        encodeJson({
          t: "run",
          fingerprint: controlFingerprint(ctx),
          argv: args,
          cwd: ctx.cwd,
          env: stringEnv(ctx.env),
          tty: {
            stdout: { isTTY: ctx.stdout.isTTY === true, columns: ctx.stdout.columns },
            stderr: { isTTY: ctx.stderr.isTTY === true, columns: ctx.stderr.columns },
          },
        }),
      );
    });
    conn.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        conn.destroy();
        return;
      }
      for (const frame of frames) {
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
        if (msg.t === "bypass") finish({ kind: "bypass", reason: msg.reason });
        else if (msg.t === "accepted") {
          accepted = true;
          clearTimeout(acceptTimer);
          // From here the worker owns the command: forward signals to it.
          for (const sig of FORWARDED_SIGNALS) {
            const handler = () => conn.write(encodeJson({ t: "signal", signal: sig }));
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
  if (verb === "status") {
    const status = await pingSocket(paths.socket);
    if (json) out(JSON.stringify(status ? { running: true, ...status } : { running: false, socket: paths.socket }));
    else out(status ? formatStatus(status) : "control process not running");
    return status ? 0 : 1;
  }
  if (verb === "start") {
    let status = await pingSocket(paths.socket);
    const already = status != null;
    if (!status) {
      spawnDaemon(ctx);
      status = await waitFor(() => pingSocket(paths.socket), 5000);
    }
    if (!status) {
      ctx.stderr.write("serve-sim: control process did not start\n");
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
    let stopped = false;
    let stoppedPid: number | null = status?.pid ?? null;
    if (status) {
      await new Promise<void>((resolve) => {
        const conn = createConnection(paths.socket);
        conn.on("connect", () => conn.write(encodeJson({ t: "stop" })));
        // Consume the reply, or the socket never reaches end/close.
        conn.resume();
        conn.on("close", () => resolve());
        conn.on("error", () => resolve());
      });
      stopped = (await waitFor(async () => (isAlive(status.pid) ? null : true), 5000)) === true;
      if (!stopped) {
        try {
          process.kill(status.pid, "SIGTERM");
        } catch {}
      }
    }
    if (!status) {
      // Alive but not answering (wedged or stopped): terminate it if the
      // pid really is our daemon, not a recycled pid.
      const rec = readPidRecord(paths.pidFile);
      if (rec && rec.pid !== process.pid && isAlive(rec.pid) && looksLikeDaemon(rec.pid)) {
        try {
          process.kill(rec.pid, "SIGTERM");
          stoppedPid = rec.pid;
          stopped = (await waitFor(async () => (isAlive(rec.pid) ? null : true), 3000)) === true;
        } catch {}
      }
    }
    const cleared = await clearStaleControlFiles(paths);
    const wasRunning = stoppedPid != null;
    if (json) out(JSON.stringify({ wasRunning, pid: stoppedPid, stopped: wasRunning && (stopped || status != null), clearedStale: cleared }));
    else out(wasRunning ? `stopped (pid ${stoppedPid})` : cleared ? "not running (cleared stale files)" : "not running");
    return 0;
  }
  ctx.stderr.write(`serve-sim: unknown control verb '${verb}'\n${CONTROL_USAGE}\n`);
  return 1;
}
