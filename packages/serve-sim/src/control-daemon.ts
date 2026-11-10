/**
 * The persistent control process: a Unix-socket server that keeps a small
 * pool of pre-warmed workers (see control-worker.ts) and hands each incoming
 * command to one of them, relaying its stdout/stderr and exit status back to
 * the thin client. It exits after a quiet period, when stopped, when its
 * socket is taken over by another daemon, or when the dist it was started
 * from is rebuilt.
 */
import { spawn, type ChildProcess } from "child_process";
import { chmodSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createConnection, createServer, type Server, type Socket } from "net";
import { dirname } from "path";
import {
  FORWARDED_SIGNALS,
  FRAME_STDERR,
  FRAME_STDOUT,
  FrameDecoder,
  encodeFrame,
  encodeJson,
  fingerprintMismatch,
  isStaleBuild,
  parseJsonFrame,
  type ControlFingerprint,
  type ControlMessage,
  type ControlStatus,
} from "./control-protocol";

interface ControlDaemonOptions {
  socket: string;
  pidFile: string;
  /** Spawns one warm worker (stdio must include an IPC channel). */
  spawnWorker: () => ChildProcess;
  fingerprint: ControlFingerprint;
  idleMs: number;
  poolSize: number;
  /** Ownership/idle check period; defaults to min(1s, idleMs / 4). */
  checkIntervalMs?: number;
}

interface ControlDaemon {
  /** Resolves once the daemon has fully shut down. */
  closed: Promise<void>;
  stop: (reason: string) => void;
}

interface Worker {
  child: ChildProcess;
  ready: boolean;
}

const MAX_SPAWN_FAILURES = 3;

/** Probe a socket path: true only if a control daemon answers a ping. */
export function pingSocket(socket: string, timeoutMs = 500): Promise<ControlStatus | null> {
  return new Promise((resolve) => {
    const conn = createConnection(socket);
    const decoder = new FrameDecoder();
    const done = (status: ControlStatus | null) => {
      clearTimeout(timer);
      conn.destroy();
      resolve(status);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    conn.on("connect", () => conn.write(encodeJson({ t: "ping" })));
    conn.on("data", (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          const msg = parseJsonFrame(frame);
          if (msg?.t === "pong") return done(msg.status);
        }
      } catch {
        done(null);
      }
    });
    conn.on("error", () => done(null));
    conn.on("close", () => done(null));
  });
}

function listen(server: Server, socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socket);
  });
}

/**
 * Bind the socket, clearing a stale one left by a dead daemon. Returns false
 * when a live daemon already owns it (the caller should just exit).
 */
async function bindExclusive(server: Server, socket: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await listen(server, socket);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (await pingSocket(socket)) return false;
      try {
        unlinkSync(socket);
      } catch {}
    }
  }
  return false;
}

function inodeOf(path: string): number | null {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
}

async function startControlDaemon(opts: ControlDaemonOptions): Promise<ControlDaemon | null> {
  mkdirSync(dirname(opts.socket), { recursive: true, mode: 0o700 });
  const server = createServer();
  if (!(await bindExclusive(server, opts.socket))) {
    server.close();
    return null;
  }
  try {
    chmodSync(opts.socket, 0o600);
  } catch {}
  const socketInode = inodeOf(opts.socket);
  const startedAt = Date.now();
  let lastActiveAt = startedAt;
  let busy = 0;
  let served = 0;
  let spawnFailures = 0;
  let stopping = false;
  const pool: Worker[] = [];
  const waiting: Array<(worker: Worker | null) => void> = [];
  const busyChildren = new Set<ChildProcess>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const status = (): ControlStatus => ({
    pid: process.pid,
    startedAt,
    lastActiveAt,
    idleMs: opts.idleMs,
    warm: pool.filter((w) => w.ready).length,
    busy,
    served,
    socket: opts.socket,
  });

  const writePidFile = () => {
    const tmp = `${opts.pidFile}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, socket: opts.socket, startedAt }), { mode: 0o600 });
      renameSync(tmp, opts.pidFile);
    } catch {}
  };
  writePidFile();

  const ownsSocket = () => socketInode != null && inodeOf(opts.socket) === socketInode;

  function spawnWorker(): void {
    if (stopping) return;
    let child: ChildProcess;
    try {
      child = opts.spawnWorker();
    } catch {
      onSpawnFailure();
      return;
    }
    const worker: Worker = { child, ready: false };
    pool.push(worker);
    // Anything a worker prints before it is assigned is load noise.
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.on("message", (msg: { t?: string }) => {
      if (msg?.t !== "ready" || worker.ready) return;
      worker.ready = true;
      spawnFailures = 0;
      const waiter = waiting.shift();
      if (waiter) {
        removeFromPool(worker);
        waiter(worker);
        refill();
      }
    });
    child.on("exit", () => {
      if (!pool.includes(worker)) return;
      removeFromPool(worker);
      if (!worker.ready) onSpawnFailure();
      else refill();
    });
    child.on("error", () => {});
  }

  function onSpawnFailure(): void {
    spawnFailures++;
    if (spawnFailures >= MAX_SPAWN_FAILURES) {
      // Workers can't load (broken dist?). Send everyone in-process.
      for (const waiter of waiting.splice(0)) waiter(null);
      shutdown("workers failing to start");
      return;
    }
    if (waiting.length > 0) refill();
  }

  function removeFromPool(worker: Worker): void {
    const i = pool.indexOf(worker);
    if (i >= 0) pool.splice(i, 1);
  }

  function refill(): void {
    if (stopping) return;
    const want = opts.poolSize + Math.max(0, waiting.length - pool.filter((w) => w.ready).length);
    while (pool.length < want) spawnWorker();
  }

  function acquire(): Promise<Worker | null> {
    const ready = pool.find((w) => w.ready);
    if (ready) {
      removeFromPool(ready);
      refill();
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => {
      waiting.push(resolve);
      refill();
    });
  }

  function release(worker: Worker): void {
    // A pristine worker whose caller went away goes back to the pool.
    if (stopping || pool.length >= opts.poolSize) worker.child.kill("SIGTERM");
    else pool.unshift(worker);
  }

  async function runJob(conn: Socket, msg: Extract<ControlMessage, { t: "run" }>): Promise<void> {
    const mismatch = fingerprintMismatch(opts.fingerprint, msg.fingerprint);
    if (mismatch) {
      conn.end(encodeJson({ t: "bypass", reason: `fingerprint:${mismatch}` }));
      if (isStaleBuild(mismatch)) shutdown("dist rebuilt");
      return;
    }
    if (stopping) {
      conn.end(encodeJson({ t: "bypass", reason: "stopping" }));
      return;
    }
    busy++;
    lastActiveAt = Date.now();
    conn.write(encodeJson({ t: "accepted" }));
    let clientGone = false;
    let child: ChildProcess | null = null;
    const pendingSignals: string[] = [];
    conn.on("close", () => {
      clientGone = true;
      // The caller died mid-command (e.g. SIGKILL): don't leave it running.
      child?.kill("SIGTERM");
    });
    conn.on("error", () => {});
    const onClientMessage = (m: ControlMessage) => {
      if (m.t !== "signal" || !FORWARDED_SIGNALS.includes(m.signal)) return;
      if (child) child.kill(m.signal);
      else pendingSignals.push(m.signal);
    };
    jobListeners.set(conn, onClientMessage);

    const worker = await acquire();
    if (!worker) {
      busy--;
      if (!clientGone) conn.end(encodeJson({ t: "exit", code: 1, signal: null }));
      return;
    }
    if (clientGone) {
      busy--;
      release(worker);
      maybeFinishStop();
      return;
    }
    child = worker.child;
    busyChildren.add(child);
    served++;
    child.stdout?.removeAllListeners("data");
    child.stderr?.removeAllListeners("data");
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!clientGone) conn.write(encodeFrame(FRAME_STDOUT, chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!clientGone) conn.write(encodeFrame(FRAME_STDERR, chunk));
    });
    child.removeAllListeners("exit");
    child.once("close", (code, signal) => {
      busyChildren.delete(child!);
      busy--;
      lastActiveAt = Date.now();
      if (!clientGone) conn.end(encodeJson({ t: "exit", code, signal }));
      maybeFinishStop();
    });
    const { t: _t, fingerprint: _fp, ...payload } = msg;
    child.send({ t: "run", ...payload });
    for (const sig of pendingSignals) child.kill(sig as NodeJS.Signals);
  }

  const jobListeners = new WeakMap<Socket, (m: ControlMessage) => void>();

  server.on("connection", (conn) => {
    const decoder = new FrameDecoder();
    let first = true;
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        conn.destroy();
        return;
      }
      for (const frame of frames) {
        const msg = parseJsonFrame(frame);
        if (!msg) continue;
        if (!first) {
          jobListeners.get(conn)?.(msg);
          continue;
        }
        first = false;
        if (msg.t === "ping") conn.end(encodeJson({ t: "pong", status: status() }));
        else if (msg.t === "stop") {
          conn.end(encodeJson({ t: "stopping" }));
          shutdown("stop requested");
        } else if (msg.t === "run") void runJob(conn, msg);
        else conn.destroy();
      }
    });
  });

  const checkMs = opts.checkIntervalMs ?? Math.max(50, Math.min(1000, Math.floor(opts.idleMs / 4)));
  const timer = setInterval(() => {
    if (!ownsSocket()) {
      // Another daemon replaced our socket (or it was deleted): nobody can
      // reach us any more.
      shutdown("socket taken over", { unlink: false });
      return;
    }
    if (busy === 0 && waiting.length === 0 && Date.now() - lastActiveAt >= opts.idleMs) shutdown("idle");
  }, checkMs);

  let unlinkOnExit = true;
  function shutdown(_reason: string, o: { unlink?: boolean } = {}): void {
    if (o.unlink === false) unlinkOnExit = false;
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    server.close();
    if (unlinkOnExit && ownsSocket()) {
      try {
        unlinkSync(opts.socket);
      } catch {}
    }
    if (unlinkOnExit) {
      try {
        unlinkSync(opts.pidFile);
      } catch {}
    }
    for (const waiter of waiting.splice(0)) waiter(null);
    for (const w of pool.splice(0)) w.child.kill("SIGTERM");
    maybeFinishStop();
  }

  function maybeFinishStop(): void {
    if (stopping && busy === 0 && busyChildren.size === 0) resolveClosed();
  }

  refill();
  return { closed, stop: (reason) => shutdown(reason) };
}

/** Entry for `node serve-sim.js __control-daemon`. */
export async function runControlDaemonProcess(opts: {
  binFile: string;
  socket: string;
  pidFile: string;
  fingerprint: ControlFingerprint;
  idleMs: number;
  poolSize: number;
  roleEnv: string;
}): Promise<void> {
  // Don't pin whatever directory the first caller happened to be in.
  try {
    process.chdir("/");
  } catch {}
  const daemon = await startControlDaemon({
    socket: opts.socket,
    pidFile: opts.pidFile,
    fingerprint: opts.fingerprint,
    idleMs: opts.idleMs,
    poolSize: opts.poolSize,
    spawnWorker: () =>
      spawn(process.execPath, [opts.binFile], {
        cwd: "/",
        env: { ...process.env, [opts.roleEnv]: "worker" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
  });
  if (!daemon) return; // another daemon already owns the socket
  process.on("SIGTERM", () => daemon.stop("SIGTERM"));
  process.on("SIGINT", () => daemon.stop("SIGINT"));
  process.on("SIGHUP", () => {});
  await daemon.closed;
  process.exit(0);
}
