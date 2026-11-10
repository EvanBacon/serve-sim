/**
 * Opt-in rolling buffer of recent small frames, so an agent can ask "what
 * just happened?" without having recorded an MP4. Off by default; while off
 * nothing here runs (no timer, no native calls, no event-log subscription).
 *
 * While on, a sampler ticks at `fps`. Each tick reads the native content
 * counter (one locked integer, the same one `/ax/settle` polls). If the
 * screen changed since the last tick it asks the addon for a downscaled JPEG
 * (`thumbnailJpeg`: one copy of the current surface + a vImage downscale +
 * JPEG encode on a utility queue); if not, it stores a repeat sample that
 * points at the previous frame, so timestamps keep a steady grid without
 * duplicate bytes. A snapshot byte-identical to the previous frame is a
 * repeat too (covers addons without the counter).
 *
 * Bounded three ways: samples older than `seconds` are evicted; the frame
 * bytes are capped at `maxBytes` (oldest frames go first, the newest always
 * stays); and the sample/event counts are capped. A frame is freed once no
 * sample shows it.
 *
 * Timeline: every time is server wall-clock ms (`Date.now()` at the tick),
 * the same clock event-log entries are stamped with, so the event join needs
 * no offset. Views report `t` = seconds since the oldest sample in the view
 * (`origin`), like recording media time, and reuse the recording index's
 * event shaping (`recordingIndexEvents`).
 */
import type { EventLogEntry } from "./event-log";
import { recordingIndexEvents, type RecordingIndexEvent } from "./recording-index";

export type RollingBufferOptions = {
  /** Window length kept, seconds. */
  seconds: number;
  /** Sampling rate, ticks per second. */
  fps: number;
  /** Long edge of the stored JPEGs, px. */
  maxDimension: number;
  /** JPEG quality, 0..1. */
  quality: number;
  /** Cap on stored JPEG bytes. */
  maxBytes: number;
};

const MIB = 1024 * 1024;

/**
 * 20 s at 4 fps, 640 px long edge (294x640 on an iPhone 17 Pro, ~1/4 of
 * native: UI text stays readable), quality 0.6. 4 fps catches the steps of a
 * transition without paying for every 60 Hz frame; the content counter means
 * a static screen costs one integer read per tick.
 * @lintignore Exported for tests.
 */
export const ROLLING_BUFFER_DEFAULTS: RollingBufferOptions = {
  seconds: 20,
  fps: 4,
  maxDimension: 640,
  quality: 0.6,
  maxBytes: 24 * MIB,
};

/** @lintignore Exported for tests. */
export const ROLLING_BUFFER_LIMITS = {
  seconds: { min: 1, max: 60 },
  fps: { min: 1, max: 10 },
  maxDimension: { min: 64, max: 1280 },
  quality: { min: 0.1, max: 0.95 },
  maxBytes: { min: 1 * MIB, max: 64 * MIB },
} as const;

/** Events kept per buffer (a drag is one event). */
const MAX_BUFFER_EVENTS = 1000;

export const ROLLING_BUFFER_ENV = "SERVE_SIM_BUFFER";

function parseNumber(raw: string | null, { min, max }: { min: number; max: number }, integer: boolean): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

/**
 * `/buffer/start` params: `seconds`, `fps`, `size` (long edge px),
 * `quality`, `maxMB` (MiB). Out-of-range values are errors, not clamps, so
 * a caller never gets a different buffer than it asked for.
 */
export function parseRollingBufferQuery(params: URLSearchParams): RollingBufferOptions | { error: string } {
  const L = ROLLING_BUFFER_LIMITS;
  const fields: Array<[keyof RollingBufferOptions, string, { min: number; max: number }, boolean, number]> = [
    ["seconds", "seconds", L.seconds, true, 1],
    ["fps", "fps", L.fps, true, 1],
    ["maxDimension", "size", L.maxDimension, true, 1],
    ["quality", "quality", L.quality, false, 1],
    ["maxBytes", "maxMB", { min: L.maxBytes.min / MIB, max: L.maxBytes.max / MIB }, true, MIB],
  ];
  const options = { ...ROLLING_BUFFER_DEFAULTS };
  for (const [key, param, range, integer, unit] of fields) {
    if (!params.has(param)) continue;
    const value = parseNumber(params.get(param), range, integer);
    if (value == null) {
      return { error: `${param} must be ${integer ? "an integer" : "a number"} ${range.min}..${range.max}` };
    }
    options[key] = value * unit;
  }
  return options;
}

/**
 * Server-wide default from `SERVE_SIM_BUFFER` (set by `serve-sim --buffer`):
 * unset/""/0/off/false/no → off (null); on/true/yes → defaults; an integer
 * → that many seconds. Invalid values warn and stay off.
 */
export function parseRollingBufferEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): RollingBufferOptions | null {
  const raw = (env[ROLLING_BUFFER_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "off" || raw === "false" || raw === "no") return null;
  if (raw === "on" || raw === "true" || raw === "yes") return { ...ROLLING_BUFFER_DEFAULTS };
  const parsed = parseRollingBufferQuery(new URLSearchParams({ seconds: raw }));
  if ("error" in parsed) {
    warn(`[serve-sim] Ignoring ${ROLLING_BUFFER_ENV}=${raw}: expected on/off or ${parsed.error}`);
    return null;
  }
  return parsed;
}

export type ThumbnailFrame = {
  data: Uint8Array;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
};

type StoredFrame = ThumbnailFrame & { id: number; atMs: number; refs: number };
type Sample = { atMs: number; frame: StoredFrame; changed: boolean };
type BufferedEvent = { entry: EventLogEntry; receivedAtMs: number };

export type BufferSample = { t: number; at: string; frame: number; changed: boolean };
export type BufferFrame = {
  id: number;
  t: number;
  at: string;
  bytes: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
};
export type BufferEvent = RecordingIndexEvent & {
  /** Frame on screen when the event arrived. */
  frame?: number;
  /** First changed frame after the event (after a drag's last point). */
  nextChange?: { frame: number; t: number; after: number };
};
export type BufferView = {
  /** Wall time of `t` = 0 (the oldest sample in the view); null when empty. */
  origin: string | null;
  now: string;
  samples: BufferSample[];
  frames: BufferFrame[];
  events: BufferEvent[];
};
export type BufferStats = {
  samples: number;
  frames: number;
  events: number;
  bytes: number;
  /** Ticks that found the content counter unchanged (no snapshot taken). */
  unchanged: number;
  /** Snapshots whose JPEG matched the previous frame (stored as repeats). */
  duplicates: number;
  /** Frames evicted for the byte cap or sample cap while still in the window. */
  evictedFrames: number;
  errors: number;
  lastError?: string;
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));
}

/** The frames and samples of one device's buffer. Pure: callers pass the clock. */
export class RollingFrameStore {
  private samples: Sample[] = [];
  private readonly frames = new Map<number, StoredFrame>();
  private readonly events = new Map<number, BufferedEvent>();
  private nextId = 1;
  private bytes = 0;
  private readonly counters = { unchanged: 0, duplicates: 0, evictedFrames: 0, errors: 0 };
  private lastError?: string;

  constructor(readonly options: RollingBufferOptions, private readonly device?: string) {}

  /** Hard cap on samples: the window's ticks, doubled for timer jitter. */
  private get maxSamples(): number {
    return Math.max(2, Math.ceil(this.options.seconds * this.options.fps) * 2);
  }

  /** The newest frame, i.e. what is on screen now. */
  latest(): StoredFrame | undefined {
    return this.samples.at(-1)?.frame;
  }

  /** Store a new frame at `atMs`; a byte-identical repeat of the last frame is a repeat sample. Returns its id. */
  addFrame(atMs: number, data: Uint8Array, meta: Omit<ThumbnailFrame, "data">): number {
    const last = this.latest();
    if (last && sameBytes(last.data, data)) {
      this.counters.duplicates++;
      this.pushSample({ atMs, frame: last, changed: false });
      return last.id;
    }
    const frame: StoredFrame = { ...meta, data, id: this.nextId++, atMs, refs: 0 };
    this.frames.set(frame.id, frame);
    this.bytes += data.length;
    this.pushSample({ atMs, frame, changed: true });
    this.enforceByteCap();
    return frame.id;
  }

  /** The screen is unchanged at `atMs`: a timestamp pointing at the last frame. */
  addRepeat(atMs: number): void {
    const last = this.latest();
    if (!last) return;
    this.counters.unchanged++;
    this.pushSample({ atMs, frame: last, changed: false });
  }

  /** Collect an event-log entry (this device's HID input only); updates replace by id. */
  addEvent(entry: EventLogEntry, receivedAtMs: number): void {
    if (entry.source !== "hid") return;
    if (this.device && entry.device !== this.device) return;
    this.events.delete(entry.id); // re-insert: Map order = latest update last
    this.events.set(entry.id, { entry, receivedAtMs });
    while (this.events.size > MAX_BUFFER_EVENTS) this.events.delete(this.events.keys().next().value!);
  }

  /**
   * Patch an event already collected, independent of the global event log
   * (a long drag can fall out of its ring while still going). Unknown ids
   * are ignored.
   */
  updateEvent(id: number, patch: Partial<Omit<EventLogEntry, "id">>, receivedAtMs: number): void {
    const current = this.events.get(id);
    if (!current) return;
    this.addEvent({
      ...current.entry,
      ...patch,
      id,
      ...(patch.summary != null && patch.msg == null ? { msg: patch.summary } : {}),
    }, receivedAtMs);
  }

  noteError(error: unknown): void {
    this.counters.errors++;
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  private pushSample(sample: Sample): void {
    sample.frame.refs++;
    this.samples.push(sample);
    while (this.samples.length > this.maxSamples) this.dropOldestSample(true);
  }

  private dropOldestSample(early: boolean): void {
    const sample = this.samples.shift();
    if (!sample) return;
    const frame = sample.frame;
    if (--frame.refs === 0) {
      this.frames.delete(frame.id);
      this.bytes -= frame.data.length;
      if (early) this.counters.evictedFrames++;
    }
  }

  private enforceByteCap(): void {
    const newest = this.latest();
    while (this.bytes > this.options.maxBytes && this.samples.length > 0 && this.samples[0]!.frame !== newest) {
      this.dropOldestSample(true);
    }
  }

  /**
   * Drop samples (and frames, events) older than the window at `nowMs`. The
   * newest sample always stays: it is the screen as last seen, even if
   * sampling stalled.
   */
  evict(nowMs: number): void {
    const cutoff = nowMs - this.options.seconds * 1000;
    while (this.samples.length > 1 && this.samples[0]!.atMs < cutoff) this.dropOldestSample(false);
    for (const [id, event] of this.events) {
      if (event.receivedAtMs < cutoff) this.events.delete(id);
    }
  }

  clear(): void {
    this.samples = [];
    this.frames.clear();
    this.events.clear();
    this.bytes = 0;
  }

  frame(id: number): StoredFrame | undefined {
    return this.frames.get(id);
  }

  /** The frame on screen at `atMs` (latest sample at or before it). */
  frameAt(atMs: number): StoredFrame | undefined {
    let found: StoredFrame | undefined;
    for (const sample of this.samples) {
      if (sample.atMs > atMs) break;
      found = sample.frame;
    }
    return found;
  }

  stats(): BufferStats {
    return {
      samples: this.samples.length,
      frames: this.frames.size,
      events: this.events.size,
      bytes: this.bytes,
      ...this.counters,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /** Samples at or after `sinceMs` (default: all), the frames they show, and events joined to them. */
  view(nowMs: number, { sinceMs }: { sinceMs?: number } = {}): BufferView {
    const samples = sinceMs == null ? this.samples : this.samples.filter((s) => s.atMs >= sinceMs);
    const originMs = samples[0]?.atMs;
    const now = new Date(nowMs).toISOString();
    if (originMs == null) return { origin: null, now, samples: [], frames: [], events: [] };
    const t = (atMs: number) => round3((atMs - originMs) / 1000);
    const frames = new Map<number, BufferFrame>();
    for (const { frame } of samples) {
      if (frames.has(frame.id)) continue;
      frames.set(frame.id, {
        id: frame.id,
        t: t(frame.atMs),
        at: new Date(frame.atMs).toISOString(),
        bytes: frame.data.length,
        width: frame.width,
        height: frame.height,
        sourceWidth: frame.sourceWidth,
        sourceHeight: frame.sourceHeight,
      });
    }
    const originSec = originMs / 1000;
    const durationSec = (nowMs - originMs) / 1000;
    const shaped = recordingIndexEvents(this.events.values(), {
      startUptime: originSec,
      startWall: new Date(originMs).toISOString(),
      originUptime: originSec,
      originWall: new Date(originMs).toISOString(),
      wallMinusUptimeSec: 0,
    }, { durationSec });
    const events: BufferEvent[] = shaped.map((event) => {
      const atMs = originMs + event.t * 1000;
      const endMs = originMs + (event.tEnd ?? event.t) * 1000;
      let shown: StoredFrame | undefined;
      let next: Sample | undefined;
      for (const sample of samples) {
        if (sample.atMs <= atMs) shown = sample.frame;
        if (sample.changed && sample.atMs > endMs) { next = sample; break; }
      }
      return {
        ...event,
        ...(shown ? { frame: shown.id } : {}),
        ...(next ? { nextChange: { frame: next.frame.id, t: t(next.atMs), after: round3((next.atMs - endMs) / 1000) } } : {}),
      };
    });
    return {
      origin: new Date(originMs).toISOString(),
      now,
      samples: samples.map((s) => ({ t: t(s.atMs), at: new Date(s.atMs).toISOString(), frame: s.frame.id, changed: s.changed })),
      frames: [...frames.values()],
      events,
    };
  }
}

export type RollingBufferSamplerDeps = {
  now?: () => number;
  /** One-shot timer; defaults to an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
  /** Native content-changed frame count, or null when unavailable. */
  contentChangeCount: () => number | null;
  /** Downscaled JPEG of the current screen at the buffer's size/quality; null before the first frame. */
  thumbnail: (maxDimension: number, quality: number) => Promise<ThumbnailFrame | null>;
  /** Event-log subscription for the event join; omitted collects no events. */
  subscribeEventLog?: (subscriber: (entry: EventLogEntry) => void) => () => void;
  device?: string;
};

const defaultTimer = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { clear: () => clearTimeout(timer) };
};

type SamplerRun = {
  store: RollingFrameStore;
  startedAt: number;
  timer?: { clear: () => void };
  /** Content counter at the last stored frame. */
  lastCount: number | null;
  unsubscribe?: () => void;
};

/** Drives a `RollingFrameStore` from the capture: start/stop, one tick at a time. */
export class RollingBufferSampler {
  private current: SamplerRun | null = null;

  constructor(private readonly deps: RollingBufferSamplerDeps) {}

  get enabled(): boolean {
    return this.current !== null;
  }

  get store(): RollingFrameStore | null {
    return this.current?.store ?? null;
  }

  get startedAt(): number | null {
    return this.current?.startedAt ?? null;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  start(options: RollingBufferOptions): void {
    if (this.current) return;
    const store = new RollingFrameStore(options, this.deps.device);
    const current: SamplerRun = { store, startedAt: this.now(), lastCount: null };
    this.current = current;
    current.unsubscribe = this.deps.subscribeEventLog?.((entry) => store.addEvent(entry, this.now()));
    this.schedule(current, 0);
  }

  /** An event-log entry that skipped subscribers (a silent drag update); ignored while off. */
  noteEvent(entry: EventLogEntry): void {
    this.current?.store.addEvent(entry, this.now());
  }

  /** Patch a collected event the global log already evicted; ignored while off. */
  updateEvent(id: number, patch: Partial<Omit<EventLogEntry, "id">>): void {
    this.current?.store.updateEvent(id, patch, this.now());
  }

  stop(): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    current.timer?.clear();
    current.unsubscribe?.();
    current.store.clear();
  }

  private schedule(current: SamplerRun, ms: number): void {
    current.timer = (this.deps.setTimer ?? defaultTimer)(() => void this.tick(current), ms);
  }

  private async tick(current: SamplerRun): Promise<void> {
    if (this.current !== current) return;
    const { store } = current;
    const atMs = this.now();
    const tickStart = atMs;
    try {
      const count = this.deps.contentChangeCount();
      if (count != null && count === current.lastCount && store.latest()) {
        store.addRepeat(atMs);
      } else {
        const frame = await this.deps.thumbnail(store.options.maxDimension, store.options.quality);
        if (this.current !== current) return;
        if (frame) {
          const { data, ...meta } = frame;
          // Own the bytes: the addon's buffer is ours, but a caller-provided
          // view could be reused.
          store.addFrame(atMs, Buffer.from(data), meta);
          current.lastCount = count;
        }
      }
    } catch (error) {
      if (this.current !== current) return;
      store.noteError(error);
    }
    store.evict(this.now());
    // Fixed pacing from the tick's start; a slow snapshot doesn't pile up ticks.
    const interval = 1000 / store.options.fps;
    this.schedule(current, Math.max(0, interval - (this.now() - tickStart)));
  }
}
