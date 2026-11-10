/**
 * Settle detector: after an action, wait until the screen stops changing.
 *
 * "Quiet" means `quietSamples` consecutive samples, `intervalMs` apart, with
 * the same AX signature and (when the capture path reports it) the same
 * content-change counter (IOSurface seed changes, so idle-floor re-emits do
 * not count). A hard `timeoutMs` bounds the wait. Pure: the clock, sleep and
 * sampler are injected so the logic is tested without a simulator.
 */

export const DEFAULT_SETTLE_TIMEOUT_MS = 3000;
export const MAX_SETTLE_TIMEOUT_MS = 30_000;
export const DEFAULT_SETTLE_INTERVAL_MS = 200;

export interface SettleSample<T> {
  /** Equal signatures mean an unchanged AX tree. */
  signature: string;
  /** Monotonic content-frame counter, or null when the capture path can't tell. */
  frames: number | null;
  value: T;
}

export interface SettleOptions<T> {
  sample(): Promise<SettleSample<T>>;
  now(): number;
  sleep(ms: number): Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  quietSamples?: number;
  /** Wait before the first sample (lets a tap's effect begin). */
  initialDelayMs?: number;
}

export interface SettleResult<T> {
  settled: boolean;
  waitedMs: number;
  reason: "quiet" | "timeout";
  samples: number;
  /** Which signals were used: AX always; frames only when the capture path reported a counter. */
  signals: { ax: true; frames: boolean };
  /** On timeout: what changed in the last comparison. */
  busy?: Array<"ax" | "frames">;
  lastError?: string;
  /** The last successful sample's value (the settled screen when `settled`). */
  last?: T;
}

/** Parse a user timeout: undefined/empty → default, junk → null, else clamped ms. */
export function clampSettleTimeout(input: unknown): number | null {
  if (input == null || input === "") return DEFAULT_SETTLE_TIMEOUT_MS;
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_SETTLE_TIMEOUT_MS, Math.max(0, Math.round(n)));
}

export async function waitForSettle<T>(options: SettleOptions<T>): Promise<SettleResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_SETTLE_INTERVAL_MS;
  const quietSamples = Math.max(2, options.quietSamples ?? 2);
  const start = options.now();
  const elapsed = () => options.now() - start;

  let samples = 0;
  let streak = 0;
  let previous: SettleSample<T> | null = null;
  let last: SettleSample<T> | null = null;
  let lastError: string | undefined;
  let busy: Array<"ax" | "frames"> = [];
  let sawFrames = false;

  const take = async () => {
    samples++;
    try {
      const current = await options.sample();
      last = current;
      if (current.frames != null) sawFrames = true;
      if (previous) {
        busy = [];
        if (previous.signature !== current.signature) busy.push("ax");
        if (previous.frames != null && current.frames != null && previous.frames !== current.frames) busy.push("frames");
        streak = busy.length === 0 ? streak + 1 : 1;
      } else {
        streak = 1;
      }
      previous = current;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      previous = null;
      streak = 0;
    }
  };

  const result = (settled: boolean): SettleResult<T> => ({
    settled,
    waitedMs: elapsed(),
    reason: settled ? "quiet" : "timeout",
    samples,
    signals: { ax: true, frames: sawFrames },
    ...(settled ? {} : busy.length ? { busy } : {}),
    ...(!settled && lastError ? { lastError } : {}),
    ...(last ? { last: (last as SettleSample<T>).value } : {}),
  });

  if (options.initialDelayMs) await options.sleep(Math.min(options.initialDelayMs, timeoutMs));
  await take();
  for (;;) {
    if (streak >= quietSamples) return result(true);
    const remaining = timeoutMs - elapsed();
    if (remaining <= 0) return result(false);
    await options.sleep(Math.min(intervalMs, remaining));
    await take();
  }
}
