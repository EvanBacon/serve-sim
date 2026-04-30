#!/usr/bin/env bun
import { execSync, spawn as nodeSpawn, type ChildProcess } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { homedir, networkInterfaces } from "os";
import { join, resolve } from "path";
import { STATE_DIR, stateFileForDevice, listStateFiles } from "./state";

// Embed the Swift helper so `bun build --compile` produces a self-contained
// `serve-sim` binary. In dev / the un-compiled ESM bin the returned path is a
// real file on disk; inside a compiled binary it points at bun's virtual FS
// and we extract the bytes to a cached location on first use.
import swiftHelperEmbeddedPath from "../bin/serve-sim-bin" with { type: "file" };

interface ServerState {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
}

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function readState(udid?: string): ServerState | null {
  if (udid) {
    return readStateFile(stateFileForDevice(udid));
  }
  // No udid: return the first live device state
  for (const file of listStateFiles()) {
    const state = readStateFile(file);
    if (state) return state;
  }
  return null;
}

/**
 * Snapshot simctl's boot state once per `readStateFile` batch. A full
 * `simctl list devices -j` is ~50ms; doing it per-state multiplied the cost
 * by the number of running helpers. We cache for 1 second so a flurry of
 * readStateFile() calls (e.g. readAllStates loop) shares one lookup.
 */
let bootedSnapshot: { at: number; booted: Set<string> | null } = {
  at: 0,
  booted: null,
};
function getBootedUdids(): Set<string> | null {
  const now = Date.now();
  if (bootedSnapshot.booted && now - bootedSnapshot.at < 1000) {
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
    // simctl lookup failed (Xcode offline, etc.) — we can't prove the device
    // is shutdown, so don't treat as stale. Returns null so caller skips the
    // booted check for this invocation.
    return null;
  }
}

function readStateFile(file: string): ServerState | null {
  try {
    if (!existsSync(file)) return null;
    const state = JSON.parse(readFileSync(file, "utf-8")) as ServerState;
    try {
      process.kill(state.pid, 0);
    } catch {
      // Helper process is gone — drop the file.
      unlinkSync(file);
      return null;
    }
    // The helper is alive, but the simulator it was bound to may have been
    // shut down (Simulator.app quit, machine slept, `simctl shutdown`, etc.).
    // When that happens the helper keeps accepting /stream.mjpeg connections
    // but never emits frames, so clients hang on "Connecting...". Detect and
    // recycle here so --detach / --list always return a working stream.
    const booted = getBootedUdids();
    if (booted && !booted.has(state.device)) {
      console.error(
        `[serve-sim] Helper pid ${state.pid} is bound to device ${state.device} which is no longer booted — killing stale helper.`,
      );
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {}
      try {
        unlinkSync(file);
      } catch {}
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function readAllStates(): ServerState[] {
  const states: ServerState[] = [];
  for (const file of listStateFiles()) {
    const state = readStateFile(file);
    if (state) states.push(state);
  }
  return states;
}

function writeState(state: ServerState) {
  ensureStateDir();
  writeFileSync(
    stateFileForDevice(state.device),
    JSON.stringify(state, null, 2),
  );
}

function clearState(udid?: string) {
  if (udid) {
    try {
      unlinkSync(stateFileForDevice(udid));
    } catch {}
  } else {
    for (const file of listStateFiles()) {
      try {
        unlinkSync(file);
      } catch {}
    }
  }
}

function findHelperBinary(): string {
  const isEmbedded = swiftHelperEmbeddedPath.startsWith("/$bunfs/");

  // Dev / npm-installed: path bun gave us is a real file on disk.
  if (!isEmbedded && existsSync(swiftHelperEmbeddedPath)) {
    return swiftHelperEmbeddedPath;
  }
  if (!isEmbedded) {
    const rel = resolve(import.meta.dir, "../bin/serve-sim-bin");
    if (existsSync(rel)) return rel;
    throw new Error(
      `serve-sim-bin not found. Run 'bun run build:swift' first.\nChecked: ${swiftHelperEmbeddedPath}, ${rel}`,
    );
  }

  // Compiled `bun --compile` binary: extract embedded bytes to a cache dir
  // keyed by content hash so updates replace the previous extraction.
  const bytes = readFileSync(swiftHelperEmbeddedPath);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const cacheDir = resolve(homedir(), "Library/Caches/serve-sim");
  mkdirSync(cacheDir, { recursive: true });
  const extracted = resolve(cacheDir, `serve-sim-bin-${hash}`);
  if (!existsSync(extracted)) {
    writeFileSync(extracted, bytes);
    chmodSync(extracted, 0o755);
    // Re-apply ad-hoc signature so the macOS kernel will exec it.
    try {
      execSync(`codesign -s - -f ${JSON.stringify(extracted)}`, {
        stdio: "ignore",
      });
    } catch {}
  }
  return extracted;
}

// ─── Device helpers ───

function findBootedDevice(): string | null {
  try {
    const output = execSync("xcrun simctl list devices booted -j", {
      encoding: "utf-8",
    });
    const data = JSON.parse(output) as {
      devices: Record<
        string,
        Array<{ udid: string; name: string; state: string }>
      >;
    };
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.state === "Booted") return device.udid;
      }
    }
  } catch {}
  return null;
}

/**
 * Pick a sensible default device to boot when the user runs `serve-sim` with
 * no booted simulator. Prefers an available iPhone on the newest iOS runtime.
 */
function pickDefaultDevice(): { udid: string; name: string } | null {
  try {
    const output = execSync("xcrun simctl list devices -j", {
      encoding: "utf-8",
    });
    const data = JSON.parse(output) as {
      devices: Record<
        string,
        Array<{
          udid: string;
          name: string;
          state: string;
          isAvailable?: boolean;
        }>
      >;
    };
    const iosRuntimes = Object.keys(data.devices)
      .filter((k) => /SimRuntime\.iOS-/i.test(k))
      .sort((a, b) => {
        const va = (a.match(/iOS-(\d+)-(\d+)/) ?? []).slice(1).map(Number);
        const vb = (b.match(/iOS-(\d+)-(\d+)/) ?? []).slice(1).map(Number);
        return (vb[0] ?? 0) - (va[0] ?? 0) || (vb[1] ?? 0) - (va[1] ?? 0);
      });
    for (const runtime of iosRuntimes) {
      const devices = data.devices[runtime] ?? [];
      const iphone = devices.find(
        (d) => d.isAvailable !== false && /^iPhone\b/i.test(d.name),
      );
      if (iphone) return { udid: iphone.udid, name: iphone.name };
    }
  } catch {}
  return null;
}

function getDeviceName(udid: string): string | null {
  try {
    const output = execSync("xcrun simctl list devices -j", {
      encoding: "utf-8",
    });
    const data = JSON.parse(output) as {
      devices: Record<
        string,
        Array<{ udid: string; name: string; state: string }>
      >;
    };
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.udid === udid) return device.name;
      }
    }
  } catch {}
  return null;
}

function resolveDevice(nameOrUDID: string): string {
  if (
    /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(
      nameOrUDID,
    )
  ) {
    return nameOrUDID;
  }
  try {
    const output = execSync("xcrun simctl list devices -j", {
      encoding: "utf-8",
    });
    const data = JSON.parse(output) as {
      devices: Record<
        string,
        Array<{ udid: string; name: string; state: string }>
      >;
    };
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.name.toLowerCase() === nameOrUDID.toLowerCase())
          return device.udid;
      }
    }
  } catch {}
  console.error(`Could not resolve device: ${nameOrUDID}`);
  process.exit(1);
}

function isDeviceBooted(udid: string): boolean {
  try {
    const output = execSync("xcrun simctl list devices -j", {
      encoding: "utf-8",
    });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.udid === udid) return device.state === "Booted";
      }
    }
  } catch {}
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a process and wait for it to actually exit. */
function stopProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      Bun.sleepSync(25);
    } catch {
      return;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  const deadline2 = Date.now() + 500;
  while (Date.now() < deadline2) {
    try {
      process.kill(pid, 0);
      Bun.sleepSync(25);
    } catch {
      return;
    }
  }
}

/** Return PIDs currently holding a TCP port (excluding ourselves). */
function getPortHolders(port: number): number[] {
  try {
    const output = execSync(`lsof -ti tcp:${port}`, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (!output) return [];
    const myPid = process.pid;
    return output
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((pid) => Number.isFinite(pid) && pid !== myPid);
  } catch {
    return [];
  }
}

/** Kill whatever process is holding a given port. Logs the PIDs being killed. */
function killPortHolder(port: number): void {
  const pids = getPortHolders(port);
  if (pids.length === 0) return;
  console.log(
    `\x1b[90mPort ${port} busy, killing holder pid(s): ${pids.join(", ")}\x1b[0m`,
  );
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  Bun.sleepSync(100);
}

function bootDevice(udid: string): void {
  if (!isDeviceBooted(udid)) {
    try {
      execSync(`xcrun simctl boot ${udid}`, {
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (err: any) {
      const msg = (err.stderr ?? err.message ?? "").toLowerCase();
      if (!msg.includes("booted") && !msg.includes("current state")) {
        throw new Error(
          `Failed to boot device ${udid}: ${err.stderr || err.message}`,
        );
      }
    }
  }
  // Ensure Simulator.app is running so the display/framebuffer pipeline is
  // wired up. `-g` = don't bring to foreground; safe to call even if already
  // running. A short timeout keeps us from hanging on headless macOS hosts
  // (e.g. GitHub Actions runners) where `open` can block indefinitely waiting
  // for a window server that never arrives — in that environment the test
  // harness is expected to have already driven the sim via simctl.
  try {
    execSync("open -ga Simulator", {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 3_000,
    });
  } catch {}
}

function getLocalNetworkIP(): string | null {
  const interfaces = networkInterfaces();
  for (const ifaces of Object.values(interfaces)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

async function findAvailablePort(start: number): Promise<number> {
  const usedPorts = new Set(readAllStates().map((s) => s.port));
  for (let port = start; port < start + 100; port++) {
    if (usedPorts.has(port)) continue;
    try {
      const server = Bun.serve({ port, fetch: () => new Response("ok") });
      server.stop(true);
      return port;
    } catch {
      continue;
    }
  }
  throw new Error(`No available port found in range ${start}-${start + 99}`);
}

async function ensureBooted(udid: string): Promise<void> {
  bootDevice(udid);
  // `simctl bootstatus -b` blocks until the device's services are actually ready
  // (not just flipped to "Booted"). Much more reliable than polling `simctl list`.
  try {
    execSync(`xcrun simctl bootstatus ${udid} -b`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 60_000,
    });
  } catch (err: any) {
    if (!isDeviceBooted(udid)) {
      console.error(
        `Device ${udid} failed to reach booted state: ${err.stderr || err.message}`,
      );
      process.exit(1);
    }
  }
}

// ─── Helper spawn ───

interface SpawnHelperOptions {
  helperPath: string;
  udid: string;
  port: number;
  host: string;
  logFile: string;
}

/** Wait for the helper to become ready (health check + capture started). */
async function waitForHelperReady(
  pid: number,
  url: string,
  logFile: string,
  isAlive: () => boolean,
): Promise<{ ready: boolean; log: string }> {
  let ready = false;

  // Poll /health
  for (let i = 0; i < 30; i++) {
    if (!isAlive()) break;
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  if (ready) {
    // Wait for capture to start or process to exit
    const captureDeadline = Date.now() + 8_000;
    while (Date.now() < captureDeadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (!isAlive()) {
        ready = false;
        break;
      }
      try {
        const log = readFileSync(logFile, "utf-8");
        if (log.includes("Capture started")) break;
      } catch {}
    }
  }

  let log = "";
  try {
    log = readFileSync(logFile, "utf-8").trim();
  } catch {}
  return { ready, log };
}

/** Spawn the helper detached (for --detach mode). Returns after readiness check. */
async function spawnHelperDetached(opts: SpawnHelperOptions): Promise<{
  ready: boolean;
  pid: number;
  exited: boolean;
  log: string;
}> {
  const { helperPath, udid, port, host, logFile } = opts;
  const url = `http://${host}:${port}`;

  ensureStateDir();
  const logFd = openSync(logFile, "w");
  const child = nodeSpawn(helperPath, [udid, "--port", String(port)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  const childPid = child.pid!;
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
  });

  const { ready, log } = await waitForHelperReady(
    childPid,
    url,
    logFile,
    () => !childExited && isProcessAlive(childPid),
  );

  return {
    ready,
    pid: childPid,
    exited: childExited || !isProcessAlive(childPid),
    log,
  };
}

/** Spawn the helper attached (for foreground follow mode). Returns the child process. */
async function spawnHelperAttached(opts: SpawnHelperOptions): Promise<{
  ready: boolean;
  child: ChildProcess;
  log: string;
}> {
  const { helperPath, udid, port, host, logFile } = opts;
  const url = `http://${host}:${port}`;

  ensureStateDir();
  const logFd = openSync(logFile, "w");
  const child = nodeSpawn(helperPath, [udid, "--port", String(port)], {
    detached: false,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);

  const childPid = child.pid!;
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
  });

  const { ready, log } = await waitForHelperReady(
    childPid,
    url,
    logFile,
    () => !childExited && isProcessAlive(childPid),
  );

  return { ready, child, log };
}

/** Boot + spawn helper with retry logic. Returns pid on success, exits on failure. */
async function startHelper(
  udid: string,
  port: number,
  opts: { detach: boolean },
): Promise<{ pid: number; child?: ChildProcess }> {
  await ensureBooted(udid);

  const host = "127.0.0.1";
  const helperPath = findHelperBinary();
  const logFile = join(STATE_DIR, `server-${udid}.log`);
  const spawnOpts: SpawnHelperOptions = {
    helperPath,
    udid,
    port,
    host,
    logFile,
  };

  let lastLog = "";
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    killPortHolder(port);

    if (opts.detach) {
      const result = await spawnHelperDetached(spawnOpts);
      if (result.ready) {
        const state: ServerState = {
          pid: result.pid,
          port,
          device: udid,
          url: `http://${host}:${port}`,
          streamUrl: `http://${host}:${port}/stream.mjpeg`,
          wsUrl: `ws://${host}:${port}/ws`,
        };
        writeState(state);
        return { pid: result.pid };
      }
      stopProcess(result.pid);
      lastLog = result.log;
    } else {
      const result = await spawnHelperAttached(spawnOpts);
      if (result.ready) {
        const state: ServerState = {
          pid: result.child.pid!,
          port,
          device: udid,
          url: `http://${host}:${port}`,
          streamUrl: `http://${host}:${port}/stream.mjpeg`,
          wsUrl: `ws://${host}:${port}/ws`,
        };
        writeState(state);
        return { pid: result.child.pid!, child: result.child };
      }
      stopProcess(result.child.pid!);
      lastLog = result.log;
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const reason = lastLog
    ? `Helper failed:\n${lastLog}`
    : "Helper process failed to start";
  console.error(reason);
  process.exit(1);
}

// ─── Commands ───

/** Foreground follow mode (default). Stays attached, cleans up on Ctrl+C. */
async function follow(devices: string[], startPort: number, quiet: boolean) {
  const udids =
    devices.length > 0
      ? devices.map(resolveDevice)
      : (() => {
          const booted = findBootedDevice();
          if (booted) return [booted];
          const fallback = pickDefaultDevice();
          if (!fallback) {
            console.error(
              "No device specified and no available iOS simulator found.",
            );
            process.exit(1);
          }
          if (!quiet) {
            console.log(`No booted simulator — booting ${fallback.name}...`);
          }
          return [fallback.udid];
        })();

  const children = new Map<string, ChildProcess>();
  const states: ServerState[] = [];
  let port = startPort;

  for (const udid of udids) {
    // Return existing server if already running
    const existing = readState(udid);
    if (existing) {
      if (!quiet) {
        const name = getDeviceName(udid) ?? udid;
        if (udids.length > 1) console.log(`\n==> ${name} (${udid}) <==`);
        console.log(`  Already running on port ${existing.port}`);
        console.log(`  Stream:    ${existing.streamUrl}`);
        console.log(`  WebSocket: ${existing.wsUrl}`);
      }
      states.push(existing);
      continue;
    }

    port = await findAvailablePort(port);
    const { pid, child } = await startHelper(udid, port, { detach: false });

    if (child) {
      children.set(udid, child);
    }

    const host = "127.0.0.1";
    const state: ServerState = {
      pid,
      port,
      device: udid,
      url: `http://${host}:${port}`,
      streamUrl: `http://${host}:${port}/stream.mjpeg`,
      wsUrl: `ws://${host}:${port}/ws`,
    };
    states.push(state);

    if (!quiet) {
      const name = getDeviceName(udid) ?? udid;
      if (udids.length > 1) console.log(`\n==> ${name} (${udid}) <==`);
      console.log(`  Stream:    ${state.streamUrl}`);
      console.log(`  WebSocket: ${state.wsUrl}`);
      console.log(`  Port:      ${port}`);
    }

    port++;
  }

  // Machine-readable JSON to stdout
  if (states.length === 1) {
    const s = states[0]!;
    console.log(
      JSON.stringify({
        url: s.url,
        streamUrl: s.streamUrl,
        wsUrl: s.wsUrl,
        port: s.port,
        device: s.device,
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        devices: states.map((s) => ({
          url: s.url,
          streamUrl: s.streamUrl,
          wsUrl: s.wsUrl,
          port: s.port,
          device: s.device,
        })),
      }),
    );
  }

  // If no new children were spawned (all already running), exit
  if (children.size === 0) return;

  let shuttingDown = false;

  const cleanup = (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!quiet) console.log("\nShutting down...");
    for (const [udid, child] of children) {
      const pid = child.pid;
      if (pid) stopProcess(pid);
      clearState(udid);
    }
    children.clear();
    process.exit(exitCode);
  };

  // Monitor children — exit when all die (helper crashed / exited on its own)
  for (const [udid, child] of children) {
    child.on("exit", (code) => {
      if (shuttingDown) return;
      if (!quiet) console.error(`[${udid}] Helper exited (code ${code})`);
      clearState(udid);
      children.delete(udid);
      if (children.size === 0) cleanup(code ?? 1);
    });
  }

  // Clean shutdown on signal
  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));
  process.on("SIGHUP", () => cleanup(0));

  // Last-resort synchronous cleanup if something else exits the process
  process.on("exit", () => {
    for (const [udid, child] of children) {
      try {
        if (child.pid) process.kill(child.pid, "SIGTERM");
      } catch {}
      try {
        clearState(udid);
      } catch {}
    }
  });

  // Block forever
  await new Promise(() => {});
}

/** Detach mode (--detach). Spawns helpers and returns their states. */
async function detach(
  devices: string[],
  startPort: number,
): Promise<ServerState[]> {
  const udids =
    devices.length > 0
      ? devices.map(resolveDevice)
      : (() => {
          const booted = findBootedDevice();
          if (booted) return [booted];
          const fallback = pickDefaultDevice();
          if (!fallback) {
            console.error(
              "No device specified and no available iOS simulator found.",
            );
            process.exit(1);
          }
          return [fallback.udid];
        })();

  const states: ServerState[] = [];
  let port = startPort;

  for (const udid of udids) {
    const existing = readState(udid);
    if (existing) {
      states.push(existing);
      continue;
    }

    port = await findAvailablePort(port);
    await startHelper(udid, port, { detach: true });

    const host = "127.0.0.1";
    states.push({
      pid: readState(udid)!.pid,
      port,
      device: udid,
      url: `http://${host}:${port}`,
      streamUrl: `http://${host}:${port}/stream.mjpeg`,
      wsUrl: `ws://${host}:${port}/ws`,
    });

    port++;
  }

  return states;
}

function printStatesJSON(states: ServerState[]) {
  if (states.length === 1) {
    const s = states[0]!;
    console.log(
      JSON.stringify({
        url: s.url,
        streamUrl: s.streamUrl,
        wsUrl: s.wsUrl,
        port: s.port,
        device: s.device,
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        devices: states.map((s) => ({
          url: s.url,
          streamUrl: s.streamUrl,
          wsUrl: s.wsUrl,
          port: s.port,
          device: s.device,
        })),
      }),
    );
  }
}

/** List running streams (--list). */
function listStreams(deviceArg?: string) {
  if (deviceArg) {
    const udid = resolveDevice(deviceArg);
    const state = readState(udid);
    if (!state) {
      console.log(JSON.stringify({ running: false, device: udid }));
    } else {
      console.log(
        JSON.stringify({
          running: true,
          url: state.url,
          streamUrl: state.streamUrl,
          wsUrl: state.wsUrl,
          port: state.port,
          device: state.device,
          pid: state.pid,
        }),
      );
    }
    return;
  }

  const states = readAllStates();
  if (states.length === 0) {
    console.log(JSON.stringify({ running: false }));
  } else if (states.length === 1) {
    const s = states[0]!;
    console.log(
      JSON.stringify({
        running: true,
        url: s.url,
        streamUrl: s.streamUrl,
        wsUrl: s.wsUrl,
        port: s.port,
        device: s.device,
        pid: s.pid,
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        running: true,
        streams: states.map((s) => ({
          url: s.url,
          streamUrl: s.streamUrl,
          wsUrl: s.wsUrl,
          port: s.port,
          device: s.device,
          pid: s.pid,
        })),
      }),
    );
  }
}

/** Kill running streams (--kill). */
function killStreams(deviceArg?: string) {
  if (deviceArg) {
    const udid = resolveDevice(deviceArg);
    const state = readState(udid);
    if (!state) {
      console.log(JSON.stringify({ disconnected: true, device: udid }));
      return;
    }
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {}
    clearState(udid);
    console.log(JSON.stringify({ disconnected: true, device: state.device }));
  } else {
    const states = readAllStates();
    if (states.length === 0) {
      console.log(JSON.stringify({ disconnected: true, devices: [] }));
      return;
    }
    const devices: string[] = [];
    for (const state of states) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {}
      devices.push(state.device);
    }
    clearState();
    console.log(JSON.stringify({ disconnected: true, devices }));
  }
}

async function gesture(args: string[]) {
  let deviceArg: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--device" || args[i] === "-d") {
      deviceArg = args[++i];
    } else {
      filteredArgs.push(args[i]!);
    }
  }
  const state = readState(deviceArg);
  if (!state) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }

  const jsonStr = filteredArgs[0];
  if (!jsonStr) {
    console.error("Usage: serve-sim gesture '<json>'");
    console.error(
      'Example: serve-sim gesture \'{"type":"begin","x":0.5,"y":0.5}\'',
    );
    process.exit(1);
  }

  let touch: { type: string; x: number; y: number };
  try {
    touch = JSON.parse(jsonStr);
  } catch {
    console.error("Invalid JSON:", jsonStr);
    process.exit(1);
  }

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(state.wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      const json = new TextEncoder().encode(JSON.stringify(touch));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = 0x03;
      msg.set(json, 1);
      ws.send(msg);
      setTimeout(() => {
        ws.close();
        resolve();
      }, 50);
    };

    ws.onerror = () => {
      console.error("Failed to connect to serve-sim server at", state.wsUrl);
      reject(new Error("WebSocket connection failed"));
    };
  });
}

async function rotate(args: string[]) {
  let deviceArg: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--device" || args[i] === "-d") {
      deviceArg = args[++i];
    } else {
      filteredArgs.push(args[i]!);
    }
  }
  const state = readState(deviceArg);
  if (!state) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }

  const orientation = filteredArgs[0];
  const valid = new Set([
    "portrait",
    "portrait_upside_down",
    "landscape_left",
    "landscape_right",
  ]);
  if (!orientation || !valid.has(orientation)) {
    console.error(
      `Usage: serve-sim rotate <${[...valid].join("|")}> [-d udid]`,
    );
    process.exit(1);
  }

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(state.wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      const json = new TextEncoder().encode(JSON.stringify({ orientation }));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = 0x07;
      msg.set(json, 1);
      ws.send(msg);
      setTimeout(() => {
        ws.close();
        resolve();
      }, 50);
    };

    ws.onerror = () => {
      console.error("Failed to connect to serve-sim server at", state.wsUrl);
      reject(new Error("WebSocket connection failed"));
    };
  });
}

async function button(args: string[]) {
  let deviceArg: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--device" || args[i] === "-d") {
      deviceArg = args[++i];
    } else {
      filteredArgs.push(args[i]!);
    }
  }
  const state = readState(deviceArg);
  if (!state) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }

  const buttonName = filteredArgs[0] ?? "home";

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(state.wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      const json = new TextEncoder().encode(
        JSON.stringify({ button: buttonName }),
      );
      const msg = new Uint8Array(1 + json.length);
      msg[0] = 0x04;
      msg.set(json, 1);
      ws.send(msg);
      setTimeout(() => {
        ws.close();
        resolve();
      }, 50);
    };

    ws.onerror = () => {
      console.error("Failed to connect to serve-sim server at", state.wsUrl);
      reject(new Error("WebSocket connection failed"));
    };
  });
}

// Send a CoreAnimation debug option toggle to the helper, which invokes
// -[SimDevice setCADebugOption:enabled:] (CoreSimulator private category).
// The known option strings are the ones Simulator.app uses: see Protocol.swift.
async function caDebug(args: string[]) {
  let deviceArg: string | undefined;
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--device" || args[i] === "-d") {
      deviceArg = args[++i];
    } else {
      filtered.push(args[i]!);
    }
  }
  const option = filtered[0];
  const stateArg = (filtered[1] ?? "").toLowerCase();
  const enabled = stateArg === "on" || stateArg === "1" || stateArg === "true";
  const aliases: Record<string, string> = {
    blended: "debug_color_blended",
    copies: "debug_color_copies",
    copied: "debug_color_copies",
    misaligned: "debug_color_misaligned",
    offscreen: "debug_color_offscreen",
    "slow-animations": "debug_slow_animations",
    slow: "debug_slow_animations",
  };
  const resolved = option ? (aliases[option] ?? option) : undefined;
  if (
    !resolved ||
    !["on", "off", "1", "0", "true", "false"].includes(stateArg)
  ) {
    console.error(
      `Usage: serve-sim ca-debug <option> <on|off> [-d udid]\n  option shortcuts: ${Object.keys(aliases).join(", ")}`,
    );
    process.exit(1);
  }

  const stateFile = readState(deviceArg);
  if (!stateFile) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(stateFile.wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      const json = new TextEncoder().encode(
        JSON.stringify({ option: resolved, enabled }),
      );
      const msg = new Uint8Array(1 + json.length);
      msg[0] = 0x08;
      msg.set(json, 1);
      ws.send(msg);
      setTimeout(() => {
        ws.close();
        resolve();
      }, 50);
    };
    ws.onerror = () => {
      console.error(
        "Failed to connect to serve-sim server at",
        stateFile.wsUrl,
      );
      reject(new Error("WebSocket connection failed"));
    };
  });
}

// Ask the helper to invoke -[SimDevice simulateMemoryWarning].
async function memoryWarning(args: string[]) {
  let deviceArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--device" || args[i] === "-d") deviceArg = args[++i];
  }
  const stateFile = readState(deviceArg);
  if (!stateFile) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(stateFile.wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(new Uint8Array([0x09]));
      setTimeout(() => {
        ws.close();
        resolve();
      }, 50);
    };
    ws.onerror = () => {
      console.error(
        "Failed to connect to serve-sim server at",
        stateFile.wsUrl,
      );
      reject(new Error("WebSocket connection failed"));
    };
  });
}

// ─── Serve preview ───

async function serve(
  servePort: number,
  devices: string[],
  portExplicit: boolean,
  preview: { hostname?: string; tls: boolean },
) {
  // Ensure a serve-sim stream is running (start one if not)
  const existing = readAllStates();
  if (existing.length === 0) {
    console.log("Starting simulator stream...");
    await detach(devices, 3100);
  }

  const { simMiddleware } = await import("./middleware");
  const middleware = simMiddleware({
    basePath: "/",
    previewHostname: preview.hostname,
    previewTls: preview.tls,
  });

  // Try requested port; if busy and the user didn't pin it, scan forward.
  const maxScan = portExplicit ? 1 : 50;
  let boundPort = servePort;
  let lastErr: unknown;
  let bound = false;
  for (let i = 0; i < maxScan; i++) {
    const p = servePort + i;
    try {
      bindPreviewServer(p, middleware, !!preview.hostname);
      boundPort = p;
      bound = true;
      break;
    } catch (err: any) {
      lastErr = err;
      if (err?.code !== "EADDRINUSE") break;
    }
  }
  if (!bound) {
    if ((lastErr as any)?.code === "EADDRINUSE") {
      if (portExplicit) {
        console.error(
          `Port ${servePort} is already in use. Pass a different --port or stop the other process.`,
        );
      } else {
        console.error(
          `No available port found in range ${servePort}-${servePort + maxScan - 1}.`,
        );
      }
    } else {
      console.error(
        `Failed to start preview server: ${(lastErr as any)?.message ?? lastErr}`,
      );
    }
    process.exit(1);
  }

  const networkIP = getLocalNetworkIP();
  console.log("");
  console.log(`  - Local:   http://localhost:${boundPort}`);
  if (networkIP) console.log(`  - Network: http://${networkIP}:${boundPort}`);
  console.log("");

  // Exit cleanly on Ctrl+C
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  await new Promise(() => {});
}

const tunnelWebSocketHandlers = {
  open(ws: import("bun").ServerWebSocket<{ backendPort: number }>) {
    const p = ws.data.backendPort;
    const backend = new WebSocket(`ws://127.0.0.1:${p}/ws`);
    backend.binaryType = "arraybuffer";
    (ws as unknown as { __b: WebSocket }).__b = backend;
    backend.addEventListener("message", (ev) => {
      ws.send(ev.data as ArrayBuffer);
    });
    backend.addEventListener("close", () => ws.close());
    backend.addEventListener("error", () => ws.close());
  },
  message(
    ws: import("bun").ServerWebSocket<{ backendPort: number }>,
    message: ArrayBuffer | Buffer,
  ) {
    (ws as unknown as { __b?: WebSocket }).__b?.send(message);
  },
  close(ws: import("bun").ServerWebSocket<{ backendPort: number }>) {
    try {
      (ws as unknown as { __b?: WebSocket }).__b?.close();
    } catch {}
  },
};

function bindPreviewServer(
  port: number,
  middleware: ReturnType<typeof import("./middleware").simMiddleware>,
  previewTunnel: boolean,
) {
  const serveOpts: Record<string, unknown> = {
    port,
    idleTimeout: 255, // max — MJPEG streams are long-lived
    async fetch(
      req: Request,
      server: import("bun").Server<{ backendPort: number }>,
    ) {
      if (previewTunnel) {
        const u = new URL(req.url);
        if (
          req.method === "GET" &&
          (u.pathname === "/stream.mjpeg" || u.pathname === "/config")
        ) {
          const st = readAllStates()[0];
          if (!st) return new Response("No serve-sim device", { status: 404 });
          return fetch(`http://127.0.0.1:${st.port}${u.pathname}${u.search}`, {
            signal: req.signal,
            cache: "no-store",
            headers: {
              Accept: req.headers.get("Accept") ?? "*/*",
            },
          });
        }
        if (u.pathname === "/ws") {
          const st = readAllStates()[0];
          if (!st) return new Response("No serve-sim device", { status: 404 });
          const upgraded = server.upgrade(req, {
            data: { backendPort: st.port },
          });
          if (upgraded) return undefined as unknown as Response;
        }
      }

      // Methods that may carry a body get it pre-read here so the shim can
      // replay it as Node-style "data"/"end" events. Without this, any
      // middleware that reads `req.on("data"/"end")` hangs forever — which
      // was silently breaking the /exec endpoint the client uses to run
      // simctl (device picker stayed empty, header stuck on "No simulator").
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const bodyBuf = hasBody ? new Uint8Array(await req.arrayBuffer()) : null;
      return new Promise<Response>((resolve) => {
        // Minimal Node-style req/res shim
        const url = new URL(req.url);
        const listeners: Record<string, Array<(arg?: any) => void>> = {};
        const nodeReq: any = {
          url: url.pathname + url.search,
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
          on(event: string, cb: (arg?: any) => void) {
            (listeners[event] ??= []).push(cb);
          },
        };
        req.signal.addEventListener("abort", () => {
          for (const cb of listeners.close ?? []) cb();
        });

        let statusCode = 200;
        const resHeaders = new Headers();
        let bodyParts: (string | Uint8Array)[] = [];
        let streaming = false;
        let streamController: ReadableStreamDefaultController | null = null;

        const nodeRes: any = {
          writeHead(code: number, headers?: Record<string, string>) {
            statusCode = code;
            if (headers) {
              for (const [k, v] of Object.entries(headers))
                resHeaders.set(k, v);
            }
          },
          setHeader(k: string, v: string) {
            resHeaders.set(k, v);
          },
          get statusCode() {
            return statusCode;
          },
          set statusCode(c: number) {
            statusCode = c;
          },
          write(chunk: string | Uint8Array) {
            if (!streaming) {
              // First write — switch to streaming mode
              streaming = true;
              const stream = new ReadableStream({
                start(ctrl) {
                  streamController = ctrl;
                },
              });
              resolve(
                new Response(stream, {
                  status: statusCode,
                  headers: resHeaders,
                }),
              );
            }
            try {
              streamController?.enqueue(
                typeof chunk === "string"
                  ? new TextEncoder().encode(chunk)
                  : chunk,
              );
            } catch {}
          },
          end(body?: string | Uint8Array) {
            if (streaming) {
              if (body) {
                try {
                  streamController?.enqueue(
                    typeof body === "string"
                      ? new TextEncoder().encode(body)
                      : body,
                  );
                } catch {}
              }
              try {
                streamController?.close();
              } catch {}
            } else {
              if (body) bodyParts.push(body);
              const fullBody = bodyParts
                .map((p) =>
                  typeof p === "string" ? p : new TextDecoder().decode(p),
                )
                .join("");
              resolve(
                new Response(fullBody, {
                  status: statusCode,
                  headers: resHeaders,
                }),
              );
            }
          },
        };

        middleware(nodeReq, nodeRes, () => {
          resolve(new Response("Not found", { status: 404 }));
        });

        // Replay the pre-read body as Node "data"/"end" events on the next
        // microtask, giving middleware a chance to subscribe first. Wrap in
        // a Node Buffer so consumers calling chunk.toString() get the utf-8
        // string — Uint8Array.toString() returns comma-joined byte values.
        queueMicrotask(() => {
          if (bodyBuf && bodyBuf.length > 0) {
            const chunk = Buffer.from(bodyBuf);
            for (const cb of listeners.data ?? []) cb(chunk);
          }
          for (const cb of listeners.end ?? []) cb();
        });
      });
    },
  };
  if (previewTunnel) serveOpts.websocket = tunnelWebSocketHandlers;
  return Bun.serve(serveOpts as Parameters<typeof Bun.serve>[0]);
}

function printHelp() {
  console.log(`
serve-sim - Stream iOS Simulator to the browser

Usage:
  serve-sim [device...]                 Start preview server (default: localhost:3200)
  serve-sim --no-preview [device...]    Stream in foreground without a preview server
  serve-sim gesture '<json>' [-d udid]  Send a touch gesture
  serve-sim button [name] [-d udid]     Send a button press (default: home)
  serve-sim rotate <orientation> [-d udid]
                                        Set device orientation
                                        (portrait|portrait_upside_down|landscape_left|landscape_right)
  serve-sim ca-debug <option> <on|off> [-d udid]
                                        Toggle a CoreAnimation debug render flag
                                        (blended|copies|misaligned|offscreen|slow-animations)
  serve-sim memory-warning [-d udid]    Simulate a memory warning on the device

Options:
  -p, --port <port>   Starting port (preview default: 3200, stream default: 3100)
  -d, --detach        Spawn helper and exit (daemon mode)
  -q, --quiet         Suppress human-readable output, JSON only
      --no-preview    Skip the web preview server; stream in foreground only
  -H, --hostname <h>  Tunnel mode: same-origin /stream.mjpeg, /config, /ws proxied to the helper
      --tls           No-op (kept for CLI compatibility); tunnel uses path URLs
      --list [device] List running streams
      --kill [device] Kill running stream(s)
  -h, --help          Show this help

Examples:
  serve-sim                             Open simulator preview at localhost:3200
  serve-sim -p 8080                     Preview on a custom port
  serve-sim -H dev.example.com --tls    Tunnel to preview port; stream hits /stream.mjpeg on same public host
  serve-sim --no-preview                Auto-detect booted sim, stream in foreground
  serve-sim --no-preview "iPhone 16 Pro" Stream a specific device (no preview)
  serve-sim --detach                    Start streaming in background (daemon)
  serve-sim --list                      Show all running streams
  serve-sim --kill                      Stop all streams
`);
}

// ─── Main ───

const argv = process.argv.slice(2);

// Subcommands: gesture and button
if (argv[0] === "gesture") {
  await gesture(argv.slice(1));
  process.exit(0);
}
if (argv[0] === "button") {
  await button(argv.slice(1));
  process.exit(0);
}
if (argv[0] === "rotate") {
  await rotate(argv.slice(1));
  process.exit(0);
}
if (argv[0] === "ca-debug") {
  await caDebug(argv.slice(1));
  process.exit(0);
}
if (argv[0] === "memory-warning") {
  await memoryWarning(argv.slice(1));
  process.exit(0);
}
// Parse flags and positional args
let startPort: number | undefined;
let detachMode = false;
let quiet = false;
let list = false;
let kill = false;
let help = false;
let noPreview = false;
const positionalDevices: string[] = [];
let listDevice: string | undefined;
let killDevice: string | undefined;
let previewHostname: string | undefined;
let previewTls = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  switch (arg) {
    case "--port":
    case "-p":
      startPort = parseInt(argv[++i] ?? "3100", 10);
      break;
    case "--detach":
    case "-d":
      detachMode = true;
      break;
    case "--quiet":
    case "-q":
      quiet = true;
      break;
    case "--hostname":
    case "-H": {
      const v = argv[++i];
      if (!v || v.startsWith("-")) {
        console.error(
          "--hostname requires a host value (e.g. dev.example.com).",
        );
        process.exit(1);
      }
      previewHostname = v;
      break;
    }
    case "--tls":
      previewTls = true;
      break;
    case "--no-preview":
      noPreview = true;
      break;
    case "--list":
    case "-l":
      list = true;
      // Optional device arg after --list
      if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
        listDevice = argv[++i];
      }
      break;
    case "--kill":
    case "-k":
      kill = true;
      // Optional device arg after --kill
      if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
        killDevice = argv[++i];
      }
      break;
    case "--help":
    case "-h":
    case "help":
      help = true;
      break;
    default:
      if (!arg.startsWith("-")) {
        positionalDevices.push(arg);
      } else {
        console.error(`Unknown flag: ${arg}`);
        printHelp();
        process.exit(1);
      }
  }
}

if (help) {
  printHelp();
  process.exit(0);
}

if (previewTls && !previewHostname?.trim()) {
  console.error(
    "--tls requires --hostname <host> (use both to enable tunnel / same-origin stream mode).",
  );
  process.exit(1);
}

if (list) {
  listStreams(listDevice);
  process.exit(0);
}

if (kill) {
  killStreams(killDevice);
  process.exit(0);
}

if (detachMode) {
  const states = await detach(positionalDevices, startPort ?? 3100);
  printStatesJSON(states);
} else if (noPreview) {
  await follow(positionalDevices, startPort ?? 3100, quiet);
} else {
  await serve(startPort ?? 3200, positionalDevices, startPort !== undefined, {
    hostname: previewHostname?.trim() || undefined,
    tls: previewTls,
  });
}
