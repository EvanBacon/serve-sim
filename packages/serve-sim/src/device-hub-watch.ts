import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { DEVICE_HUB_INPUT_KEY } from "./device-hub-input";
import { simctlArguments } from "./simctl";

/** One `state <n>` line from `serve-sim-duo-hid watch-notify <name>`; null for anything else. */
export function parseNotifyState(line: string): number | null {
  const match = /^state (\d+)$/.exec(line.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

export interface DeviceHubInputWatch {
  close(): void;
}

export interface DeviceHubInputWatcherOptions {
  /** Path of the guest helper; resolved on every (re)start. Throwing disables the watch. */
  helper: () => string;
  /** `true`/`false` on each reading; `null` when the watch stops (reading unknown until it restarts). */
  onReading: (shadowed: boolean | null) => void;
  spawn?: typeof nodeSpawn;
  retryMs?: number;
}

/**
 * Streams Device Hub's legacy-input flag from inside the guest, so the server
 * sees 0→1 within ~50 ms instead of on a 2 s cache refresh. A legacy touch
 * sent while the flag is 1 aborts backboardd, which kills every app. The
 * helper process exits with the guest, and the watch retries until stopped.
 */
export class DeviceHubInputWatcher implements DeviceHubInputWatch {
  private stopped = false;
  private child?: ChildProcess;
  private retry?: ReturnType<typeof setTimeout>;
  private readonly spawn: typeof nodeSpawn;

  constructor(private readonly udid: string, private readonly options: DeviceHubInputWatcherOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.start();
  }

  private start(): void {
    if (this.stopped) return;
    let helper: string;
    try {
      helper = this.options.helper();
    } catch {
      return;
    }
    const child = this.spawn("/usr/bin/xcrun", simctlArguments(["spawn", this.udid, helper, "watch-notify", DEVICE_HUB_INPUT_KEY]),
      { stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    let pending = "";
    let live = false;
    child.stdin?.on("error", () => {});
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!.slice(-256);
      for (const line of lines) {
        const value = parseNotifyState(line);
        if (value == null || this.stopped) continue;
        live = true;
        this.options.onReading(value !== 0);
      }
    });
    child.on("error", () => {});
    child.once("close", () => {
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      if (live) this.options.onReading(null);
      this.retry = setTimeout(() => this.start(), this.options.retryMs ?? 1000);
      this.retry.unref?.();
    });
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.child?.stdin?.end();
    this.child?.kill();
  }
}
