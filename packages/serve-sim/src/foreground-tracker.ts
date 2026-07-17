// Tracks the sim's foreground user app by tailing SpringBoard's visibility log. This is
// focus-independent, unlike axFrontmost (which only resolves when the Simulator window is the
// focused macOS app, so it's null when driving from a browser). One shared tail per udid feeds
// both the /appstate stream and the CPU/mem sampler's per-app scoping.

import { spawn, type ChildProcess } from "node:child_process";

import { axFrontmostAsync } from "./native";

// The foreground user app: `pid` is the frontmost process, `bundleId` its app.
export interface ForegroundApp {
  pid: number;
  bundleId: string;
}

// SpringBoard logs these as "Foreground" but they aren't the visible user-facing app (widgets,
// extensions, background services); tracking them would flicker the signal mid app-launch.
const NON_UI_BUNDLE_RE =
  /(WidgetRenderer|ExtensionHost|\.extension(\.|$)|Service|PlaceholderApp|InCallService|CallUI|InCallUI|com\.apple\.Preferences\.Cellular|com\.apple\.purplebuddy|com\.apple\.chrono|com\.apple\.shuttle|com\.apple\.usernotificationsui)/i;

export function isUserFacingBundle(bundleId: string): boolean {
  return !NON_UI_BUNDLE_RE.test(bundleId);
}

// e.g. "[app<com.apple.mobilesafari>:43117] Setting process visibility to: Foreground"
export function parseForegroundAppLogMessage(message: string): ForegroundApp | null {
  const match = /\[app<([^>]+)>:(\d+)\] Setting process visibility to: Foreground/.exec(message);
  if (!match) return null;
  return { bundleId: match[1]!, pid: parseInt(match[2]!, 10) };
}

const LINE_BUFFER_LIMIT = 1024 * 1024; // drop a pathological unbroken line rather than grow forever
const RESTART_DELAY_MS = 1000; // bound the respawn rate when the log stream keeps dying (e.g. sim gone)

function spawnForegroundLogStream(udid: string): ChildProcess {
  return spawn(
    "xcrun",
    [
      "simctl", "spawn", udid, "log", "stream",
      "--style", "ndjson",
      "--level", "info",
      "--predicate",
      'process == "SpringBoard" AND eventMessage CONTAINS "Setting process visibility to: Foreground"',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
}

// The current frontmost app via the AX bridge; null when it can't be read (the common
// browser-driven case). Used only to seed a fresh tail, since its feed is edge-triggered.
export async function frontmostAppViaAx(udid: string): Promise<ForegroundApp | null> {
  try {
    const { pid, bundleId } = JSON.parse(await axFrontmostAsync(udid)) as {
      pid?: number;
      bundleId?: string;
    };
    return pid != null && bundleId ? { pid, bundleId } : null;
  } catch {
    return null;
  }
}

// Injected so tests can drive the tracker without a booted simulator.
export interface ForegroundTrackerDeps {
  spawnLogStream?: (udid: string) => ChildProcess;
  frontmostApp?: (udid: string) => Promise<ForegroundApp | null>;
  restartDelayMs?: number;
}

// Tails one SpringBoard foreground feed for a udid, holding the latest user-facing app and
// notifying listeners on change. Seeds from the AX bridge on start (a no-op unless the sim window
// is focused) because the log feed only emits on transitions.
class ForegroundTracker {
  private child: ChildProcess | null = null;
  private buf = "";
  private latest: ForegroundApp | null = null;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(app: ForegroundApp) => void>();

  constructor(
    private readonly udid: string,
    private readonly deps: Required<ForegroundTrackerDeps>,
  ) {}

  get current(): ForegroundApp | null {
    return this.latest;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  add(listener: (app: ForegroundApp) => void): void {
    this.listeners.add(listener);
  }

  remove(listener: (app: ForegroundApp) => void): void {
    this.listeners.delete(listener);
  }

  start(): void {
    if (this.child) return;
    this.stopped = false;
    // Seed from the AX bridge (a no-op unless the sim window is focused). Only apply it while we
    // still have nothing, so a log event that arrives first isn't overwritten by the slower seed.
    this.deps
      .frontmostApp(this.udid)
      .then((app) => {
        if (app && this.latest === null) this.set(app);
      })
      .catch(() => {});
    this.spawn();
  }

  private spawn(): void {
    const child = this.deps.spawnLogStream(this.udid);
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk.toString()));
    child.on("error", () => this.onChildGone());
    child.on("exit", () => this.onChildGone());
  }

  // The log-stream child died. Unless we asked it to, respawn at a bounded rate while subscribers
  // remain, so a sim restart or a dropped stream doesn't leave the foreground signal permanently stale.
  private onChildGone(): void {
    if (this.stopped || this.restartTimer) return;
    this.child = null;
    if (this.listeners.size === 0) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.child && this.listeners.size > 0) this.spawn();
    }, this.deps.restartDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.stdout?.destroy();
    this.child?.kill();
    this.child = null;
    this.buf = "";
  }

  private consume(text: string): void {
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let message: string;
      try {
        message = JSON.parse(line).eventMessage ?? "";
      } catch {
        continue;
      }
      const app = parseForegroundAppLogMessage(message);
      if (app) this.set(app);
    }
    if (this.buf.length > LINE_BUFFER_LIMIT) this.buf = "";
  }

  // Adopt a new foreground app, ignoring non-UI bundles and exact repeats. Compares pid too, so a
  // same-bundle relaunch refreshes the pid the sampler scopes by.
  private set(app: ForegroundApp): void {
    if (!isUserFacingBundle(app.bundleId)) return;
    if (app.bundleId === this.latest?.bundleId && app.pid === this.latest.pid) return;
    this.latest = app;
    for (const listener of this.listeners) {
      try {
        listener(app);
      } catch {
        // A failing listener must not stop the others from seeing the change.
      }
    }
  }
}

export interface ForegroundSubscription {
  unsubscribe: () => void;
}

export type ForegroundTrackerCache = ReturnType<typeof createForegroundTrackerCache>;

// One shared foreground tail per udid, ref-counted by subscribers (mirrors the metrics sampler
// cache). The `log stream` child runs only while something is subscribed.
export function createForegroundTrackerCache(deps: ForegroundTrackerDeps = {}) {
  const resolved: Required<ForegroundTrackerDeps> = {
    spawnLogStream: deps.spawnLogStream ?? spawnForegroundLogStream,
    frontmostApp: deps.frontmostApp ?? frontmostAppViaAx,
    restartDelayMs: deps.restartDelayMs ?? RESTART_DELAY_MS,
  };
  const byUdid = new Map<string, ForegroundTracker>();
  return {
    // Latest known foreground app for a udid, or null when nothing is tracking it.
    peek(udid: string): ForegroundApp | null {
      return byUdid.get(udid)?.current ?? null;
    },
    // Subscribe to foreground changes (or just keep the tail warm with no listener). New listeners
    // are notified on future changes only; read `peek` for the current value.
    subscribe(udid: string, onChange?: (app: ForegroundApp) => void): ForegroundSubscription {
      let tracker = byUdid.get(udid);
      if (!tracker) {
        tracker = new ForegroundTracker(udid, resolved);
        byUdid.set(udid, tracker);
        tracker.start();
      }
      const listener = onChange ?? (() => {});
      tracker.add(listener);
      return {
        unsubscribe: () => {
          tracker.remove(listener);
          // Identity-guard the eviction so a stale unsubscribe can't stop a replacement tail.
          if (tracker.listenerCount === 0 && byUdid.get(udid) === tracker) {
            tracker.stop();
            byUdid.delete(udid);
          }
        },
      };
    },
  };
}

export const foregroundTracker = createForegroundTrackerCache();
