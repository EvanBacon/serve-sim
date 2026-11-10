/**
 * Settle detector: after an action, wait until the screen stops changing.
 *
 * Signals, cheapest first:
 *
 * 1. frames-quiet (primary): the capture path's content-frame counter
 *    (IOSurface seed changes; idle re-emits don't count) unchanged for
 *    `frameQuietMs`, then ONE AX read, accepted if no frame landed while it
 *    ran, other than the read's own redraw (see isReadBlip). Polling starts
 *    immediately: a tap's highlight renders within a frame or two, and a
 *    push transition on iOS 27 keeps the counter moving for ~0.8 s.
 * 2. ax-quiet: two consecutive AX reads with the same signature. Used when
 *    frames are busy for `busyFallbackMs` (a blinking caret, a spinner,
 *    a looping animation), when a frame lands during the confirming read,
 *    and as the whole strategy when the counter is unavailable.
 * 3. timeout: `timeoutMs` is hard. No AX read starts unless the last one's
 *    duration says it ends in time, except that one read is always taken
 *    near the deadline if none was, so callers still get the current tree.
 *
 * Why the first version took ~3.7 s for a push (measured on iOS 27
 * Settings > General): ~0.9 s of real transition frames, 250 ms of quiet,
 * then three ~700 ms AX reads 200 ms apart, because it wanted two matching
 * AX samples whose frame counts also matched, and one late frame (72 -> 73)
 * between the first two reset the streak. That frame is not the status bar
 * or the counter: it is drawn by the first AX read of the new screen itself
 * (polled during reads: it lands 35-55 ms in, and only on the first read; a
 * static screen keeps the counter flat across later reads, and without AX
 * reads the counter stays flat for seconds after a push). Now frames carry
 * the "still moving" signal, a single read confirms it, and its own redraw
 * is recognized, so a push costs transition + 250 ms + one read.
 *
 * Pure: the clock, sleep, counter and AX reader are injected.
 */

const DEFAULT_SETTLE_TIMEOUT_MS = 3000;
const MAX_SETTLE_TIMEOUT_MS = 30_000;
const BLIP_MAX_FRAMES = 2;
const BLIP_WINDOW_MS = 120;
const BLIP_TAIL_MS = 80;

interface SettleRead<T> {
  /** Equal signatures mean an unchanged AX tree. */
  signature: string;
  value: T;
}

type SettleReason = "frames-quiet" | "ax-quiet" | "timeout";

export interface SettleOptions<T> {
  /** One AX read of the current screen. */
  read(): Promise<SettleRead<T>>;
  /** Monotonic content-frame counter; null (or throwing) means unavailable. */
  frames?: () => Promise<number | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
  timeoutMs?: number;
  /** Counter poll period. */
  framePollMs?: number;
  /** Counter poll period while an AX read runs. */
  readPollMs?: number;
  /** How long the counter must stay unchanged before the confirming read. */
  frameQuietMs?: number;
  /** Frames busy this long since the start: also accept ax-quiet. */
  busyFallbackMs?: number;
  /** Gap between AX reads when settling on AX alone. */
  axIntervalMs?: number;
  /** Expected AX read cost before one has been measured. */
  readCostMs?: number;
  /** Diagnostics: called with each phase event (ms since start). */
  trace?: (event: string, atMs: number, detail?: Record<string, unknown>) => void;
}

export interface SettleResult<T> {
  settled: boolean;
  waitedMs: number;
  reason: SettleReason;
  /** AX reads taken. */
  samples: number;
  /** Which signals were used: AX always; frames only when the capture path reported a counter. */
  signals: { ax: true; frames: boolean };
  /** On timeout: what was still changing. */
  busy?: Array<"ax" | "frames">;
  lastError?: string;
  /** The last successful read's value (the settled screen when `settled`). */
  last?: T;
  /**
   * Counter value the last read is known to match (frames-quiet only), so a
   * caller can tell later whether the screen has changed since.
   */
  lastFrames?: number;
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
  const pollMs = options.framePollMs ?? 50;
  const readPollMs = options.readPollMs ?? 20;
  const quietMs = options.frameQuietMs ?? 250;
  const busyFallbackMs = options.busyFallbackMs ?? 1200;
  const axIntervalMs = options.axIntervalMs ?? 100;
  const start = options.now();
  const elapsed = () => options.now() - start;
  const remaining = () => timeoutMs - elapsed();
  const trace = (event: string, detail?: Record<string, unknown>) => options.trace?.(event, Math.round(elapsed()), detail);

  let samples = 0;
  let readCostMs = options.readCostMs ?? 250;
  let previous: SettleRead<T> | null = null;
  let last: SettleRead<T> | null = null;
  let lastError: string | undefined;
  let axChanged = false;

  const readFrames = async (): Promise<number | null> => {
    if (!options.frames) return null;
    try {
      return await options.frames();
    } catch {
      return null;
    }
  };

  /** One AX read; returns whether it matched the previous one. */
  const read = async (): Promise<{ ok: boolean; same: boolean }> => {
    samples++;
    const began = options.now();
    try {
      const current = await options.read();
      readCostMs = Math.max(0, options.now() - began);
      const same = previous != null && previous.signature === current.signature;
      trace("read", { costMs: Math.round(readCostMs), same });
      axChanged = previous != null && !same;
      previous = current;
      last = current;
      return { ok: true, same };
    } catch (error) {
      readCostMs = Math.max(readCostMs, options.now() - began);
      lastError = error instanceof Error ? error.message : String(error);
      trace("read-error", { error: lastError });
      previous = null;
      return { ok: false, same: false };
    }
  };

  const finish = (reason: SettleReason, extra: { busy?: Array<"ax" | "frames">; lastFrames?: number } = {}): SettleResult<T> => {
    const settled = reason !== "timeout";
    trace(reason, { samples, ...extra });
    const value = (last as SettleRead<T> | null)?.value;
    return {
      settled,
      waitedMs: elapsed(),
      reason,
      samples,
      signals: { ax: true, frames: sawFrames },
      ...(!settled && extra.busy?.length ? { busy: extra.busy } : {}),
      ...(!settled && lastError ? { lastError } : {}),
      ...(value !== undefined ? { last: value } : {}),
      ...(settled && extra.lastFrames !== undefined ? { lastFrames: extra.lastFrames } : {}),
    };
  };

  /** Out of time: take one read if none succeeded yet (so callers get a tree), then report. */
  const timeout = async (busy: Array<"ax" | "frames">) => {
    if (!last && remaining() > -readCostMs) await read();
    return finish("timeout", { busy: axChanged && !busy.includes("ax") ? [...busy, "ax"] : busy });
  };

  /** No counter: settle on two identical AX reads. */
  const settleOnAxAlone = async (): Promise<SettleResult<T>> => {
    for (;;) {
      if (samples > 0 && remaining() < readCostMs) return finish("timeout", { busy: axChanged ? ["ax"] : [] });
      const { same } = await read();
      if (same) return finish("ax-quiet");
      const gap = Math.min(axIntervalMs, remaining() - readCostMs);
      if (gap > 0) await options.sleep(gap);
    }
  };

  /**
   * One AX read with the counter polled alongside it, so a frame can be
   * placed within the read: early (the read's own redraw, see isReadBlip)
   * or late (the screen really changed under it).
   */
  const readWatchingFrames = async (before: number) => {
    const began = options.now();
    const frames = { count: before, changesAtMs: [] as number[], lastChangeAt: began, readMs: 0 };
    const observe = (value: number | null) => {
      if (value == null || value === frames.count) return;
      frames.count = value;
      frames.lastChangeAt = options.now();
      frames.changesAtMs.push(Math.round(frames.lastChangeAt - began));
    };
    let reading = true;
    const watcher = (async () => {
      while (reading) {
        await options.sleep(readPollMs);
        if (reading) observe(await readFrames());
      }
    })();
    const result = await read();
    reading = false;
    frames.readMs = options.now() - began;
    await watcher;
    observe(await readFrames());
    return { ...result, frames };
  };

  /**
   * The first AX read of a newly presented screen makes UIKit draw once,
   * 35-55 ms in (measured on iOS 27: 74 -> 75 at +53 ms, 143 -> 144 at +44,
   * 219 -> 220 at +34; later reads of the same screen draw nothing). Treated
   * strictly as a frame, it forces a second ~200 ms read every time. A move
   * of at most BLIP_MAX_FRAMES, all inside the read's first BLIP_WINDOW_MS,
   * followed by at least BLIP_TAIL_MS of quiet before the read ended, is
   * that redraw; anything later or larger is the screen changing.
   */
  const isReadBlip = (before: number, frames: { count: number; changesAtMs: number[]; readMs: number }) => {
    const delta = frames.count - before;
    const lastAt = Math.max(...frames.changesAtMs);
    return delta > 0 && delta <= BLIP_MAX_FRAMES && lastAt <= BLIP_WINDOW_MS && frames.readMs - lastAt >= BLIP_TAIL_MS;
  };

  let count = await readFrames();
  const sawFrames = count != null;
  if (count == null) return settleOnAxAlone();

  let lastChange = options.now();
  for (;;) {
    const quietFor = options.now() - lastChange;
    const framesQuiet = quietFor >= quietMs;
    const framesBusyTooLong = elapsed() >= busyFallbackMs;

    if (framesQuiet || framesBusyTooLong) {
      if (remaining() < readCostMs) return timeout(framesQuiet ? [] : ["frames"]);
      const before: number = count;
      const { ok, same, frames } = await readWatchingFrames(before);
      const moved = frames.count !== before;
      trace("confirm", { framesQuiet, before, after: frames.count, changesAtMs: frames.changesAtMs });
      if (moved) {
        count = frames.count;
        lastChange = frames.lastChangeAt;
      }
      if (ok && framesQuiet && (!moved || isReadBlip(before, frames))) {
        return finish("frames-quiet", { lastFrames: frames.count });
      }
      if (ok && same) return finish("ax-quiet");
      if (!ok) {
        await options.sleep(Math.max(0, Math.min(pollMs, remaining())));
      } else if (framesBusyTooLong) {
        // Frames still busy and the tree still moving: pace AX reads as
        // settleOnAxAlone does instead of reading back to back until the
        // timeout, and keep watching frames across the gap.
        const gap = Math.min(axIntervalMs, remaining() - readCostMs);
        if (gap > 0) {
          await options.sleep(gap);
          const next = await readFrames();
          if (next != null && next !== count) {
            count = next;
            lastChange = options.now();
          }
        }
      }
      continue;
    }

    if (remaining() <= 0) return timeout(["frames"]);
    // Leave room for the confirming read before the deadline.
    if (remaining() <= readCostMs && !last) return timeout(["frames"]);
    await options.sleep(Math.min(pollMs, Math.max(1, remaining())));
    const next = await readFrames();
    if (next != null && next !== count) {
      trace("frames", { count: next });
      count = next;
      lastChange = options.now();
    }
  }
}
