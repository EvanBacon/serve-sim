// CPU/mem of the user's app on a booted sim, measured host-side. %CPU is per-core (can exceed 100)
// and computed from the delta in the app's cumulative CPU time between ticks, so it reflects usage
// during the interval rather than ps's decaying ~1-minute average. Scopes to the foreground app via
// the foreground tracker, tagging each sample with its bundleId (null when nothing user-facing is
// foreground, in which case the numbers cover every user app). Memory is phys_footprint, RSS fallback.

import { execFile } from "node:child_process";
import { cpus } from "node:os";
import { promisify } from "node:util";

import { foregroundTracker, frontmostAppViaAx, type ForegroundApp } from "./foreground-tracker";

const execFileAsync = promisify(execFile);

export const METRICS_SCHEMA_VERSION = 1;

// One poll's raw reading: cumulative CPU time (the sampler diffs it into a %) and current memory.
export interface AppUsage {
  bundleId: string | null; // the foreground app these numbers belong to, or null for all user apps
  processKey: string; // identity of the sampled pid set; the CPU baseline resets when it changes
  cpuSeconds: number;
  memBytes: number;
}

export interface MetricSample {
  t: number; // ms since the sampler started
  bundleId: string | null;
  cpuPct: number; // usage over the interval since the previous sample (per-core, can exceed 100)
  memBytes: number;
}

export interface MetricsMeta {
  schemaVersion: number;
  udid: string;
  hostCores: number;
  sampleIntervalMs: number;
}

export interface AppProcesses {
  pids: number[];
  cpuSeconds: number;
  rssKb: number;
}

interface PsRow {
  pid: number;
  cpuSeconds: number;
  rssKb: number;
  appPath: string; // the `.app` bundle this process runs from (host app + its extensions share it)
}

/** `ps` cputime is `[HH:]MM:SS.ss` cumulative CPU time; fold it down to seconds. */
function cputimeToSeconds(cputime: string): number {
  return cputime.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

/**
 * Processes whose executable runs from the sim's Containers/Bundle path (the user apps), not the
 * ~190 system daemons. Matches on `comm=` (the executable) rather than `args=`, so a host process
 * that merely passes a sim bundle path as an argument isn't miscounted.
 */
function parseUserAppRows(output: string, udid: string): PsRow[] {
  const device = `/Devices/${udid}/`.toUpperCase();
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    // pid, cputime, rss, then comm= (the executable path, which can contain spaces).
    const m = /^\s*(\d+)\s+([\d:.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const exe = m[4]!;
    const upper = exe.toUpperCase();
    if (!upper.includes(device) || !upper.includes("/CONTAINERS/BUNDLE/APPLICATION/")) continue;
    // First `.app` in the exec path; extensions live under it (…/MyApp.app/PlugIns/X.appex/X).
    const app = /^(.*?\.app)\//.exec(exe);
    rows.push({ pid: +m[1]!, cpuSeconds: cputimeToSeconds(m[2]!), rssKb: +m[3]!, appPath: app ? app[1]! : exe });
  }
  return rows;
}

/**
 * Aggregate the user app's processes. When the frontmost pid maps to a user app, narrow to just
 * that app's `.app` bundle (its host process + extensions). Otherwise sum every user app on the
 * sim (nothing user-facing is foreground). Null only when no user app is running at all.
 */
export function findUserAppProcesses(
  output: string,
  udid: string,
  frontmostPid?: number,
): AppProcesses | null {
  const rows = parseUserAppRows(output, udid);
  if (!rows.length) return null;

  const front = frontmostPid != null ? rows.find((r) => r.pid === frontmostPid) : undefined;
  const scoped = front ? rows.filter((r) => r.appPath === front.appPath) : rows;

  return {
    pids: scoped.map((r) => r.pid),
    cpuSeconds: scoped.reduce((sum, r) => sum + r.cpuSeconds, 0),
    rssKb: scoped.reduce((sum, r) => sum + r.rssKb, 0),
  };
}

/** Sum the per-process `phys_footprint: <n> B` lines (skips _peak and the Summary line). */
export function sumPhysFootprintBytes(output: string): number | null {
  let bytes = 0;
  let found = false;
  for (const m of output.matchAll(/^\s*phys_footprint:\s+(\d+) B$/gm)) {
    bytes += +m[1]!;
    found = true;
  }
  return found ? bytes : null;
}

// Injected so tests can drive sampleUserApp without spawning real processes.
export interface SampleDeps {
  exec?: (file: string, args: string[]) => Promise<string>;
  frontmostApp?: (udid: string) => Promise<ForegroundApp | null>;
}

/** Run a host command with a bounded timeout and output buffer, resolving its stdout. */
const runCommand = (file: string, args: string[]): Promise<string> =>
  execFileAsync(file, args, { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout);

/** The current foreground app: the tracker when it's warm, else the AX bridge; null when unknown. */
function frontmostAppOf(udid: string): Promise<ForegroundApp | null> {
  const tracked = foregroundTracker.peek(udid);
  return tracked ? Promise.resolve(tracked) : frontmostAppViaAx(udid);
}

/**
 * CPU side: the app's processes + their %CPU, and which app they belong to. `ps` and the
 * frontmost probe don't depend on each other, so they run together. bundleId is the frontmost
 * app when it's a user app, else null (the numbers then cover every user app). Null only when
 * no user app is running.
 */
async function sampleForegroundApp(
  udid: string,
  deps: Required<SampleDeps>,
): Promise<{ procs: AppProcesses; bundleId: string | null } | null> {
  const [psOutput, frontmost] = await Promise.all([
    deps.exec("ps", ["-axo", "pid=,cputime=,rss=,comm="]).catch(() => null),
    deps.frontmostApp(udid),
  ]);
  if (psOutput == null) return null;
  const procs = findUserAppProcesses(psOutput, udid, frontmost?.pid);
  if (!procs) return null;
  const bundleId = frontmost && procs.pids.includes(frontmost.pid) ? frontmost.bundleId : null;
  return { procs, bundleId };
}

/**
 * Memory side: phys_footprint of the app's processes. Depends on the pids the CPU
 * side found, so it can't start until those are known; RSS is the fallback.
 */
async function sampleMemoryBytes(procs: AppProcesses, deps: Required<SampleDeps>): Promise<number> {
  try {
    const output = await deps.exec("footprint", ["--noCategories", "--format", "bytes", ...procs.pids.map(String)]);
    return sumPhysFootprintBytes(output) ?? procs.rssKb * 1024;
  } catch {
    // footprint can exit non-zero (all pids gone mid-tick); keep the RSS fallback.
    return procs.rssKb * 1024;
  }
}

/** One poll of the foreground user app: its cumulative CPU time, memory, and the bundleId they belong to. */
export async function sampleUserApp(udid: string, deps: SampleDeps = {}): Promise<AppUsage | null> {
  const resolved: Required<SampleDeps> = {
    exec: deps.exec ?? runCommand,
    frontmostApp: deps.frontmostApp ?? frontmostAppOf,
  };
  const foreground = await sampleForegroundApp(udid, resolved);
  if (!foreground) return null;
  return {
    bundleId: foreground.bundleId,
    processKey: [...foreground.procs.pids].sort((a, b) => a - b).join(","),
    cpuSeconds: foreground.procs.cpuSeconds,
    memBytes: await sampleMemoryBytes(foreground.procs, resolved),
  };
}

export interface MetricsSamplerOptions {
  udid: string;
  intervalMs?: number;
  sample?: (udid: string) => Promise<AppUsage | null>;
  now?: () => number;
  hostCores?: number;
}

/** Polls the sim and fans samples out; reschedules only after each tick settles, so ticks never overlap. */
export class MetricsSampler {
  readonly meta: MetricsMeta;

  private readonly intervalMs: number;
  private readonly sample: (udid: string) => Promise<AppUsage | null>;
  private readonly now: () => number;
  private readonly listeners = new Set<(sample: MetricSample) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt: number | null = null;
  // Previous reading, to turn cumulative CPU time into a per-interval %.
  private prev: { t: number; bundleId: string | null; processKey: string; cpuSeconds: number } | null = null;

  /** Build a sampler for one udid, resolving the interval, clock, and host core count. */
  constructor(opts: MetricsSamplerOptions) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.sample = opts.sample ?? sampleUserApp;
    this.now = opts.now ?? (() => performance.now()); // monotonic: immune to NTP clock jumps in the CPU delta
    this.meta = {
      schemaVersion: METRICS_SCHEMA_VERSION,
      udid: opts.udid,
      hostCores: opts.hostCores ?? cpus().length,
      sampleIntervalMs: this.intervalMs,
    };
  }

  /** Number of active subscribers. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Subscribe to samples; returns an unsubscribe function. */
  onSample(listener: (sample: MetricSample) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Poll once, derive the interval %CPU, and fan the sample out to every listener. */
  async tickOnce(): Promise<MetricSample | null> {
    this.startedAt ??= this.now();
    // Timestamp the observation up front: sample() reads cumulative CPU via `ps` before the slower
    // footprint probe, so anchoring the delta here (not after sample() returns) keeps variable
    // footprint latency out of the elapsed-time denominator — otherwise it distorts CPU%.
    const t = this.now() - this.startedAt;
    const reading = await this.sample(this.meta.udid);
    if (!reading) return null;

    const cpuPct = this.cpuPctSince(reading, t);
    this.prev = { t, bundleId: reading.bundleId, processKey: reading.processKey, cpuSeconds: reading.cpuSeconds };

    const sample: MetricSample = { t, bundleId: reading.bundleId, cpuPct, memBytes: reading.memBytes };
    for (const listener of this.listeners) {
      try {
        listener(sample);
      } catch {
        // A failing subscriber (e.g. a write to an already-closed SSE response)
        // must not starve the other viewers of this sample.
      }
    }
    return sample;
  }

  /**
   * %CPU over the interval since the previous reading, from the delta in cumulative CPU time.
   * Zero on the first tick, an app switch, or a changed process set (no comparable baseline, since
   * cumulative CPU is per-process); a drop in cumulative time (a process exited) clamps to zero.
   */
  private cpuPctSince(reading: AppUsage, t: number): number {
    const prev = this.prev;
    if (!prev || prev.bundleId !== reading.bundleId || prev.processKey !== reading.processKey || t <= prev.t) {
      return 0;
    }
    const pct = ((reading.cpuSeconds - prev.cpuSeconds) / ((t - prev.t) / 1000)) * 100;
    return pct > 0 ? +pct.toFixed(1) : 0;
  }

  /** Begin the poll loop; a no-op if it is already running. */
  start(): void {
    if (this.timer) return;
    this.startedAt ??= this.now();
    // Track this loop's own timer identity: a stop()+start() during an in-flight tick would make
    // this.timer truthy again, so a bare `if (this.timer)` check would schedule a second, overlapping
    // loop. Reschedule only while this.timer still points at the timer this loop last set.
    let currentTimer: ReturnType<typeof setTimeout>;
    const loop = async (): Promise<void> => {
      await this.tickOnce().catch(() => {});
      if (this.timer === currentTimer) {
        currentTimer = setTimeout(loop, this.intervalMs);
        this.timer = currentTimer;
      }
    };
    currentTimer = setTimeout(loop, this.intervalMs);
    this.timer = currentTimer;
  }

  /** Stop the poll loop. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export interface MetricsSubscription {
  meta: MetricsMeta;
  unsubscribe: () => void;
}

export type MetricsSamplerCache = ReturnType<typeof createMetricsSamplerCache>;

/** One shared sampler per udid (like the ax streamer cache); ref-counted by subscribers. */
export function createMetricsSamplerCache(
  makeSampler: (udid: string) => MetricsSampler = (udid) => new MetricsSampler({ udid }),
) {
  const byUdid = new Map<string, MetricsSampler>();
  return {
    subscribe(udid: string, listener: (sample: MetricSample) => void): MetricsSubscription {
      let sampler = byUdid.get(udid);
      if (!sampler) {
        sampler = makeSampler(udid);
        byUdid.set(udid, sampler);
        sampler.start();
      }
      const off = sampler.onSample(listener);
      return {
        meta: sampler.meta,
        unsubscribe: () => {
          off();
          // Identity-guard the eviction: a double-called or stale unsubscribe must not
          // delete a replacement sampler that a later subscriber created for this udid.
          if (sampler.listenerCount === 0 && byUdid.get(udid) === sampler) {
            sampler.stop();
            byUdid.delete(udid);
          }
        },
      };
    },
  };
}
