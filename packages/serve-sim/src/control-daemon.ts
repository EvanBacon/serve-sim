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
import {
  FORWARDED_SIGNALS,
  FRAME_STDERR,
  FRAME_STDOUT,
  FrameDecoder,
  encodeFrame,
  encodeJson,
  fingerprintMismatch,
  isDispatchable,
  isStaleBuild,
  parseJsonFrame,
  unsafeControlDir,
  withoutNodeRuntimeEnv,
  type ControlFingerprint,
  type ControlMessage,
  type ControlPaths,
  type ControlStatus,
} from "./control-protocol";

interface ControlDaemonOptions {
  paths: ControlPaths;
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
  /** Last bytes a worker printed while loading, for the fail file. */
  loadOutput: string;
}

const MAX_SPAWN_FAILURES = 3;
/** How long an accepted caller has to answer `go` before its worker is freed. */
const GO_TIMEOUT_MS = 10_000;
/** Cap on waiting for replies to flush before the daemon exits. */
const DRAIN_TIMEOUT_MS = 1000;

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
    // Create the socket owner-only from the start: no window before chmod.
    const previous = process.umask(0o077);
    try {
      server.listen(socket);
    } finally {
      process.umask(previous);
    }
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
  const { socket, pidFile, failFile, dir } = opts.paths;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Callers send their whole environment here: refuse a directory that
  // someone else owns or can write to.
  const unsafe = unsafeControlDir(dir);
  if (unsafe) throw new Error(`control dir ${dir} is ${unsafe}`);
  const server = createServer();
  if (!(await bindExclusive(server, socket))) {
    server.close();
    return null;
  }
  try {
    chmodSync(socket, 0o600);
  } catch {}
  const socketInode = inodeOf(socket);
  const startedAt = Date.now();
  let lastActiveAt = startedAt;
  let busy = 0;
  let served = 0;
  let spawnFailures = 0;
  let lastLoadOutput = "";
  let stopping = false;
  const pool: Worker[] = [];
  const waiting: Array<(worker: Worker | null) => void> = [];
  const busyChildren = new Set<ChildProcess>();
  /** Accepted callers that haven't said `go` yet, and the worker held for each. */
  const held = new Map<Socket, Worker>();
  const holdTimers = new Map<Socket, ReturnType<typeof setTimeout>>();
  const holdWatchers = new Map<Socket, () => void>();
  const connections = new Set<Socket>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const status = (): ControlStatus => ({
    pid: process.pid,
    startedAt,
    lastActiveAt,
    idleMs: opts.idleMs,
    warm: pool.filter((w) => w.ready).length,
    warming: pool.filter((w) => !w.ready).length,
    busy,
    served,
    socket,
  });

  const writeJsonFile = (file: string, value: unknown) => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {}
  };
  writeJsonFile(pidFile, { pid: process.pid, socket, startedAt });

  const ownsSocket = () => socketInode != null && inodeOf(socket) === socketInode;
  /** Exited, or its IPC channel is gone; its `close` may not have been handled yet. */
  const isGone = (w: Worker) => w.child.exitCode != null || w.child.signalCode != null || !w.child.connected;

  function spawnWorker(): void {
    if (stopping) return;
    let child: ChildProcess;
    try {
      child = opts.spawnWorker();
    } catch (error) {
      lastLoadOutput = (error as Error).message;
      onSpawnFailure();
      return;
    }
    const worker: Worker = { child, ready: false, loadOutput: "" };
    pool.push(worker);
    // Anything a worker prints before it is assigned is load noise, kept
    // only to explain a worker that never becomes ready.
    const keep = (chunk: Buffer) => {
      if (!worker.ready) worker.loadOutput = (worker.loadOutput + chunk.toString()).slice(-4096);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("message", (msg: { t?: string }) => {
      if (msg?.t !== "ready" || worker.ready) return;
      worker.ready = true;
      worker.loadOutput = "";
      if (spawnFailures > 0 || served === 0) {
        try {
          unlinkSync(failFile);
        } catch {}
      }
      spawnFailures = 0;
      const waiter = waiting.shift();
      if (waiter) {
        removeFromPool(worker);
        waiter(worker);
        refill();
      }
    });
    // "close", not "exit": a failed load's output can arrive after exit.
    child.on("close", () => {
      if (!pool.includes(worker)) return;
      removeFromPool(worker);
      if (!worker.ready) {
        lastLoadOutput = worker.loadOutput;
        onSpawnFailure();
      } else refill();
    });
    child.on("error", (error) => {
      lastLoadOutput = error.message;
    });
  }

  function onSpawnFailure(): void {
    spawnFailures++;
    if (spawnFailures >= MAX_SPAWN_FAILURES) {
      // Workers can't load (broken install?). Tell callers to stop starting
      // daemons for this build, and send everyone in-process.
      writeJsonFile(failFile, {
        at: Date.now(),
        binMtimeMs: opts.fingerprint.binMtimeMs,
        mainMtimeMs: opts.fingerprint.mainMtimeMs,
        reason: lastLoadOutput,
      });
      shutdown("workers failing to start");
      return;
    }
    // Back off a little, then keep the pool warm so the next caller doesn't
    // pay for a cold spawn.
    setTimeout(refill, 100 * spawnFailures).unref();
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
    if (stopping) return Promise.resolve(null);
    // A dead worker stays in the pool until its `close` handler refills.
    const ready = pool.find((w) => w.ready && !isGone(w));
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
    if (stopping || isGone(worker) || pool.length >= opts.poolSize) worker.child.kill("SIGTERM");
    else pool.unshift(worker);
  }

  function hold(conn: Socket, worker: Worker, onExit: () => void): void {
    held.set(conn, worker);
    holdWatchers.set(conn, onExit);
    worker.child.once("close", onExit);
  }

  /** Stop holding the caller's worker; returns it if it was still held. */
  function unhold(conn: Socket): Worker | undefined {
    const worker = held.get(conn);
    if (!worker) return undefined;
    held.delete(conn);
    clearTimeout(holdTimers.get(conn));
    holdTimers.delete(conn);
    const onExit = holdWatchers.get(conn);
    holdWatchers.delete(conn);
    if (onExit) worker.child.off("close", onExit);
    return worker;
  }

  /** Nothing has run yet: tell the caller to run the command itself. */
  function bypass(conn: Socket, reason: string): void {
    if (!conn.destroyed) conn.end(encodeJson({ t: "bypass", reason }));
  }

  async function runJob(conn: Socket, msg: Extract<ControlMessage, { t: "run" }>): Promise<void> {
    const mismatch = fingerprintMismatch(opts.fingerprint, msg.fingerprint);
    if (mismatch) {
      bypass(conn, `fingerprint:${mismatch}`);
      if (isStaleBuild(mismatch)) shutdown("dist rebuilt");
      return;
    }
    // Don't trust the client's filter: only short one-shot commands may
    // occupy a worker (and keep the daemon alive).
    if (!Array.isArray(msg.argv) || !isDispatchable(msg.argv)) return bypass(conn, "not dispatchable");
    if (stopping) return bypass(conn, "stopping");
    busy++;
    lastActiveAt = Date.now();
    let clientGone = false;
    let child: ChildProcess | null = null;
    conn.on("close", () => {
      clientGone = true;
      const worker = unhold(conn);
      if (worker) {
        // Accepted but never told to go: the worker is still pristine.
        busy--;
        release(worker);
        maybeFinishStop();
      }
      // The caller died mid-command (e.g. SIGKILL): don't leave it running.
      child?.kill("SIGTERM");
    });
    conn.on("error", () => {});

    // Hold a worker before accepting, so "no worker" is still a bypass.
    const worker = await acquire();
    if (!worker || clientGone || stopping || isGone(worker)) {
      busy--;
      if (worker) release(worker);
      if (!clientGone) bypass(conn, !worker ? "no worker available" : stopping ? "stopping" : "worker exited");
      maybeFinishStop();
      return;
    }
    // Nothing has run yet if the held worker dies before `go` (an outside
    // `pkill`, a crash): send the caller in-process rather than leave it,
    // and this daemon, waiting on a dead child.
    const dropHeld = (reason: string) => {
      if (!unhold(conn)) return;
      busy--;
      release(worker);
      bypass(conn, reason);
      maybeFinishStop();
    };
    hold(conn, worker, () => dropHeld("worker exited"));
    // Freed before any late `go` is honoured, so bypass is still safe.
    holdTimers.set(conn, setTimeout(() => dropHeld("go timeout"), GO_TIMEOUT_MS));
    conn.write(encodeJson({ t: "accepted" }));

    jobListeners.set(conn, (m: ControlMessage) => {
      if (m.t === "go") {
        if (held.get(conn) !== worker) return;
        if (isGone(worker)) return dropHeld("worker exited");
        unhold(conn);
        start(worker);
      } else if (m.t === "signal" && child && FORWARDED_SIGNALS.includes(m.signal)) {
        child.kill(m.signal);
      }
    });

    function start(w: Worker): void {
      const c = w.child;
      child = c;
      busyChildren.add(c);
      served++;
      lastActiveAt = Date.now();
      c.stdout?.removeAllListeners("data");
      c.stderr?.removeAllListeners("data");
      c.stdout?.on("data", (chunk: Buffer) => {
        if (!clientGone) conn.write(encodeFrame(FRAME_STDOUT, chunk));
      });
      c.stderr?.on("data", (chunk: Buffer) => {
        if (!clientGone) conn.write(encodeFrame(FRAME_STDERR, chunk));
      });
      // The command never reached the worker (it died just now): the
      // caller can still run it itself.
      let undelivered = false;
      c.removeAllListeners("close");
      c.once("close", (code, signal) => {
        busyChildren.delete(c);
        busy--;
        lastActiveAt = Date.now();
        if (undelivered) {
          served--;
          bypass(conn, "worker exited");
        }
        else if (!clientGone) conn.end(encodeJson({ t: "exit", code, signal }));
        maybeFinishStop();
      });
      const { t: _t, fingerprint: _fp, ...payload } = msg;
      try {
        c.send({ t: "run", ...payload }, (error) => {
          if (error) undelivered = true;
        });
      } catch {
        undelivered = true;
      }
    }
  }

  const jobListeners = new WeakMap<Socket, (m: ControlMessage) => void>();

  server.on("connection", (conn) => {
    connections.add(conn);
    conn.on("close", () => {
      connections.delete(conn);
      if (stopping) maybeFinishStop();
    });
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
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  function shutdown(_reason: string, o: { unlink?: boolean } = {}): void {
    if (o.unlink === false) unlinkOnExit = false;
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    server.close();
    if (unlinkOnExit && ownsSocket()) {
      try {
        unlinkSync(socket);
      } catch {}
    }
    if (unlinkOnExit) {
      try {
        unlinkSync(pidFile);
      } catch {}
    }
    // Queued and accepted-but-not-started callers haven't run anything.
    for (const waiter of waiting.splice(0)) waiter(null);
    for (const conn of [...held.keys()]) {
      const worker = unhold(conn)!;
      busy--;
      worker.child.kill("SIGTERM");
      bypass(conn, "stopping");
    }
    for (const w of pool.splice(0)) w.child.kill("SIGTERM");
    maybeFinishStop();
  }

  function maybeFinishStop(): void {
    // Running commands finish first; then replies already queued (bypass,
    // exit) get a moment to reach their callers before the process exits.
    if (!stopping || busy > 0 || busyChildren.size > 0) return;
    if (connections.size === 0) {
      if (drainTimer) clearTimeout(drainTimer);
      resolveClosed();
      return;
    }
    drainTimer ??= setTimeout(() => {
      for (const conn of connections) conn.destroy();
      resolveClosed();
    }, DRAIN_TIMEOUT_MS);
  }

  refill();
  return { closed, stop: (reason) => shutdown(reason) };
}

/** Entry for `node serve-sim.js __control-daemon`. */
export async function runControlDaemonProcess(opts: {
  binFile: string;
  paths: ControlPaths;
  fingerprint: ControlFingerprint;
  idleMs: number;
  poolSize: number;
  roleEnv: string;
}): Promise<void> {
  // Don't pin whatever directory the first caller happened to be in.
  try {
    process.chdir("/");
  } catch {}
  let daemon: ControlDaemon | null;
  try {
    daemon = await startControlDaemon({
      paths: opts.paths,
      fingerprint: opts.fingerprint,
      idleMs: opts.idleMs,
      poolSize: opts.poolSize,
      spawnWorker: () =>
        spawn(process.execPath, [opts.binFile], {
          cwd: "/",
          // The first caller's node flags must not leak into later callers.
          env: { ...withoutNodeRuntimeEnv(process.env), [opts.roleEnv]: "worker" },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        }),
    });
  } catch (error) {
    process.stderr.write(`serve-sim: control process refused to start: ${(error as Error).message}\n`);
    process.exit(1);
  }
  if (!daemon) return; // another daemon already owns the socket
  const running = daemon;
  process.on("SIGTERM", () => running.stop("SIGTERM"));
  process.on("SIGINT", () => running.stop("SIGINT"));
  process.on("SIGHUP", () => {});
  await running.closed;
  process.exit(0);
}
