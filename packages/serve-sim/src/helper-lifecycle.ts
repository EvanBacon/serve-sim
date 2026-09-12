/**
 * Detached-helper discovery and simulator-gone lifecycle.
 *
 * `--list` / `--kill` must track a helper for as long as its process is alive
 * (and, when the pidfile is stale, as long as it is still listening on the
 * recorded port). Simulator boot state is *not* a reason to drop the registry
 * entry — that is what left PPID-1 orphans invisible after `simctl shutdown`.
 *
 * Helpers started with `--exit-on-simulator-shutdown` poll simctl and exit
 * after a short grace once every target device is confirmed unbooted. The
 * poll uses setTimeout backoff, not a tight loop.
 */
import { execFileSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { sleepSync } from "./runtime";
import { getPortHolders } from "./ports";
import { debugHelper, debugState } from "./debug";
import type { ServeSimDeviceState } from "./state";
import { writeServeSimState } from "./state";

export const SIMULATOR_SHUTDOWN_GRACE_MS = 5_000;
export const SIMULATOR_SHUTDOWN_POLL_MS = 2_000;
export const SIMULATOR_SHUTDOWN_POLL_MAX_MS = 10_000;

const SIMULATOR_UDID_RE =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export function isSimulatorUdid(value: string): boolean {
  return SIMULATOR_UDID_RE.test(value);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a process and wait for it to actually exit. */
export function stopProcess(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      sleepSync(25);
    } catch {
      return;
    }
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  const deadline2 = Date.now() + 500;
  while (Date.now() < deadline2) {
    try { process.kill(pid, 0); sleepSync(25); } catch { return; }
  }
}

export function looksLikeServeSimProcess(commandLine: string): boolean {
  return /serve-sim(?:-bin)?/.test(commandLine);
}

export function readProcessCommandLine(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split(String.fromCharCode(0)).join(" ").trim();
  } catch {}
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1_000,
    }).trim();
  } catch {
    return null;
  }
}

export function parseDeviceState(raw: string): ServeSimDeviceState | null {
  try {
    const state = JSON.parse(raw) as Partial<ServeSimDeviceState>;
    if (
      typeof state.pid !== "number" ||
      typeof state.port !== "number" ||
      typeof state.device !== "string" ||
      typeof state.url !== "string" ||
      typeof state.streamUrl !== "string" ||
      typeof state.wsUrl !== "string"
    ) {
      return null;
    }
    return state as ServeSimDeviceState;
  } catch {
    return null;
  }
}

/**
 * Resolve a persisted state record to a live helper. Prefer the recorded pid;
 * if that process is gone, recover via the recorded listen port when the
 * listener still looks like serve-sim (covers a stale/wrong pidfile).
 */
export function resolveLiveHelperState(
  state: ServeSimDeviceState,
  deps: {
    isAlive?: (pid: number) => boolean;
    portHolders?: (port: number) => number[];
    commandLine?: (pid: number) => string | null;
  } = {},
): ServeSimDeviceState | null {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const portHolders = deps.portHolders ?? getPortHolders;
  const commandLine = deps.commandLine ?? readProcessCommandLine;

  if (isAlive(state.pid)) return state;

  for (const pid of portHolders(state.port)) {
    if (pid === process.pid || !isAlive(pid)) continue;
    const cmd = commandLine(pid);
    if (cmd == null || !looksLikeServeSimProcess(cmd)) continue;
    debugState(
      "recovered helper for %s via port %d pid %d (recorded pid %d was dead)",
      state.device,
      state.port,
      pid,
      state.pid,
    );
    return { ...state, pid };
  }
  return null;
}

/** Drop the file only when no live helper remains. */
export function dropStateFileIfDead(file: string): void {
  try { unlinkSync(file); } catch {}
}

export function persistRecoveredState(state: ServeSimDeviceState): void {
  try {
    writeServeSimState(state);
  } catch (err) {
    debugState("failed to rewrite recovered state for %s: %o", state.device, err);
  }
}

/** What to do with a live helper whose backing simulator may have been shut down. */
export type StaleStateAction = "keep" | "recycle-self" | "recycle-helper";

/**
 * Decide how to treat a live helper when the device may no longer be booted.
 *
 * Used by `--detach` reuse (recycle a helper bound to a dead sim so a fresh
 * one can boot) and by the preview grid (stop our own in-process session
 * without SIGTERMing the whole server). `--list` / `--kill` must not use
 * `recycle-*` as a reason to drop the pidfile — the process is still alive.
 */
export function classifyStaleState(
  state: { pid: number; device: string },
  booted: Set<string> | null,
  selfPid: number,
): StaleStateAction {
  if (booted && isSimulatorUdid(state.device) && !booted.has(state.device)) {
    return state.pid === selfPid ? "recycle-self" : "recycle-helper";
  }
  return "keep";
}

export type ListStream = {
  url: string;
  streamUrl: string;
  wsUrl: string;
  port: number;
  device: string;
  pid: number;
};

export function formatListPayload(
  states: ServeSimDeviceState[],
  device?: string,
): { running: false; device?: string } | ({ running: true } & ListStream) | { running: true; streams: ListStream[] } {
  if (device) {
    const state = states.find((s) => s.device === device);
    if (!state) return { running: false, device };
    return { running: true, ...listStream(state) };
  }
  if (states.length === 0) return { running: false };
  if (states.length === 1) return { running: true, ...listStream(states[0]!) };
  return { running: true, streams: states.map(listStream) };
}

function listStream(state: ServeSimDeviceState): ListStream {
  return {
    url: state.url,
    streamUrl: state.streamUrl,
    wsUrl: state.wsUrl,
    port: state.port,
    device: state.device,
    pid: state.pid,
  };
}

/** PIDs `--kill` should signal: recorded helper + any serve-sim listener on its port. */
export function collectKillPids(
  state: ServeSimDeviceState,
  deps: {
    portHolders?: (port: number) => number[];
    commandLine?: (pid: number) => string | null;
    selfPid?: number;
  } = {},
): number[] {
  const portHolders = deps.portHolders ?? getPortHolders;
  const commandLine = deps.commandLine ?? readProcessCommandLine;
  const selfPid = deps.selfPid ?? process.pid;
  const pids = new Set<number>();
  if (state.pid > 0 && state.pid !== selfPid) pids.add(state.pid);
  for (const pid of portHolders(state.port)) {
    if (pid === selfPid) continue;
    const cmd = commandLine(pid);
    if (cmd != null && !looksLikeServeSimProcess(cmd)) continue;
    pids.add(pid);
  }
  return [...pids];
}

export type BootCheck = (udids: readonly string[]) => Promise<Set<string> | null>;

export type ShutdownWatch = {
  /** Advance one poll. Returns `"exit"` once every target has been unbooted for `graceMs`. */
  tick: () => Promise<"continue" | "exit">;
  nextDelayMs: () => number;
  reset: () => void;
};

/**
 * Pure-state watchdog: no timers. `startSimulatorShutdownWatch` drives `tick`
 * on a backoff schedule. A `null` boot check (simctl failed) never counts as
 * "gone" — we cannot prove the device shut down.
 */
export function createSimulatorShutdownWatch(
  udids: readonly string[],
  opts: {
    checkBooted: BootCheck;
    now?: () => number;
    graceMs?: number;
    pollMs?: number;
    maxPollMs?: number;
  },
): ShutdownWatch {
  const graceMs = opts.graceMs ?? SIMULATOR_SHUTDOWN_GRACE_MS;
  const pollMs = opts.pollMs ?? SIMULATOR_SHUTDOWN_POLL_MS;
  const maxPollMs = opts.maxPollMs ?? SIMULATOR_SHUTDOWN_POLL_MAX_MS;
  const now = opts.now ?? Date.now;
  const targets = [...new Set(udids.filter(Boolean))];

  let goneSince: number | null = null;
  let delayMs = pollMs;

  const reset = () => {
    goneSince = null;
    delayMs = pollMs;
  };

  return {
    reset,
    nextDelayMs: () => delayMs,
    tick: async () => {
      if (targets.length === 0) return "continue";
      const booted = await opts.checkBooted(targets);
      if (booted == null) {
        debugHelper("shutdown watch: boot check unknown; keeping helper alive");
        reset();
        delayMs = Math.min(maxPollMs, Math.max(pollMs, delayMs));
        return "continue";
      }
      const anyBooted = targets.some((udid) => booted.has(udid));
      if (anyBooted) {
        reset();
        delayMs = Math.min(maxPollMs, Math.round(delayMs * 1.5) || pollMs);
        return "continue";
      }
      const t = now();
      if (goneSince == null) goneSince = t;
      delayMs = pollMs;
      if (t - goneSince >= graceMs) return "exit";
      return "continue";
    },
  };
}

export function startSimulatorShutdownWatch(
  udids: readonly string[],
  opts: {
    checkBooted: BootCheck;
    onExit: () => void;
    graceMs?: number;
    pollMs?: number;
    maxPollMs?: number;
  },
): { stop: () => void } {
  const watch = createSimulatorShutdownWatch(udids, opts);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const loop = async () => {
    if (stopped) return;
    try {
      const result = await watch.tick();
      if (stopped) return;
      if (result === "exit") {
        debugHelper("shutdown watch: target simulator(s) gone; exiting helper");
        opts.onExit();
        return;
      }
    } catch (err) {
      debugHelper("shutdown watch tick failed: %o", err);
    }
    if (stopped) return;
    timer = setTimeout(() => { void loop(); }, watch.nextDelayMs());
  };

  timer = setTimeout(() => { void loop(); }, watch.nextDelayMs());
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
