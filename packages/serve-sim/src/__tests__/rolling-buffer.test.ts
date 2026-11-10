import { describe, expect, test } from "bun:test";
import type { EventLogEntry } from "../event-log";
import {
  ROLLING_BUFFER_DEFAULTS,
  ROLLING_BUFFER_LIMITS,
  RollingBufferSampler,
  RollingFrameStore,
  parseRollingBufferEnv,
  parseRollingBufferQuery,
  type RollingBufferOptions,
  type ThumbnailFrame,
} from "../rolling-buffer";

const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const opts = (overrides: Partial<RollingBufferOptions> = {}): RollingBufferOptions => ({ ...ROLLING_BUFFER_DEFAULTS, ...overrides });
const jpeg = (fill: number, bytes = 100) => Buffer.alloc(bytes, fill);
const meta = { width: 294, height: 640, sourceWidth: 1206, sourceHeight: 2622 };

describe("options", () => {
  test("defaults are a 20 s window at 4 fps, 640 px long edge", () => {
    expect(ROLLING_BUFFER_DEFAULTS).toEqual({ seconds: 20, fps: 4, maxDimension: 640, quality: 0.6, maxBytes: 24 * 1024 * 1024 });
    expect(parseRollingBufferQuery(new URLSearchParams())).toEqual(ROLLING_BUFFER_DEFAULTS);
  });

  test("query params override, with maxMB in MiB", () => {
    expect(parseRollingBufferQuery(new URLSearchParams("seconds=10&fps=8&size=480&quality=0.5&maxMB=8"))).toEqual({
      seconds: 10, fps: 8, maxDimension: 480, quality: 0.5, maxBytes: 8 * 1024 * 1024,
    });
  });

  test("out-of-range and malformed values are errors, not clamps", () => {
    for (const q of ["seconds=0", "seconds=61", "seconds=abc", "fps=0", "fps=11", "fps=2.5", "size=10", "size=5000",
      "quality=0", "quality=1.5", "maxMB=0", "maxMB=65", "seconds="]) {
      expect(parseRollingBufferQuery(new URLSearchParams(q))).toHaveProperty("error");
    }
  });

  test("hard caps bound memory", () => {
    expect(ROLLING_BUFFER_LIMITS.seconds.max).toBe(60);
    expect(ROLLING_BUFFER_LIMITS.fps.max).toBe(10);
    expect(ROLLING_BUFFER_LIMITS.maxBytes.max).toBe(64 * 1024 * 1024);
  });

  test("env: unset/off disables, on uses defaults, a number sets seconds", () => {
    const warn: string[] = [];
    const w = (m: string) => warn.push(m);
    expect(parseRollingBufferEnv({}, w)).toBeNull();
    for (const off of ["", "0", "off", "false", "no"]) expect(parseRollingBufferEnv({ SERVE_SIM_BUFFER: off }, w)).toBeNull();
    for (const on of ["on", "true", "yes"]) expect(parseRollingBufferEnv({ SERVE_SIM_BUFFER: on }, w)).toEqual(ROLLING_BUFFER_DEFAULTS);
    expect(parseRollingBufferEnv({ SERVE_SIM_BUFFER: "30" }, w)).toEqual(opts({ seconds: 30 }));
    expect(warn).toEqual([]);
    expect(parseRollingBufferEnv({ SERVE_SIM_BUFFER: "999" }, w)).toBeNull();
    expect(warn[0]).toContain("SERVE_SIM_BUFFER");
  });

});

describe("RollingFrameStore", () => {
  test("a changed tick stores a frame; an unchanged tick stores only a repeat sample", () => {
    const store = new RollingFrameStore(opts());
    const a = store.addFrame(T0, jpeg(1), meta);
    store.addRepeat(T0 + 250);
    store.addRepeat(T0 + 500);
    const b = store.addFrame(T0 + 750, jpeg(2), meta);
    expect(store.stats()).toMatchObject({ samples: 4, frames: 2, bytes: 200 });
    const view = store.view(T0 + 800);
    expect(view.samples.map((s) => [s.t, s.frame, s.changed])).toEqual([
      [0, a, true], [0.25, a, false], [0.5, a, false], [0.75, b, true],
    ]);
    expect(view.frames.map((f) => f.id)).toEqual([a, b]);
    expect(view.origin).toBe(new Date(T0).toISOString());
  });

  test("a repeat before any frame is ignored", () => {
    const store = new RollingFrameStore(opts());
    store.addRepeat(T0);
    expect(store.stats()).toMatchObject({ samples: 0, frames: 0 });
  });

  test("samples older than the window are evicted; a frame stays while a sample shows it", () => {
    const store = new RollingFrameStore(opts({ seconds: 10 }));
    const a = store.addFrame(T0, jpeg(1), meta);
    for (let i = 1; i <= 50; i++) store.addRepeat(T0 + i * 250); // static for 12.5 s
    store.evict(T0 + 12_500);
    const view = store.view(T0 + 12_500);
    // Oldest kept sample is 10 s back and still points at frame a.
    expect(view.samples[0]!.at).toBe(new Date(T0 + 2_500).toISOString());
    expect(view.frames.map((f) => f.id)).toEqual([a]);
    expect(store.stats().bytes).toBe(100);
    const b = store.addFrame(T0 + 12_750, jpeg(2), meta);
    store.evict(T0 + 23_000);
    expect(store.view(T0 + 23_000).frames.map((f) => f.id)).toEqual([b]);
    expect(store.stats()).toMatchObject({ frames: 1, bytes: 100 });
  });

  test("the byte cap evicts the oldest frames even inside the window, keeping the newest", () => {
    const store = new RollingFrameStore(opts({ maxBytes: 1000 }));
    const ids = Array.from({ length: 25 }, (_, i) => store.addFrame(T0 + i * 100, jpeg(i, 100), meta));
    expect(store.stats().bytes).toBeLessThanOrEqual(1000);
    expect(store.stats().frames).toBe(10);
    expect(store.view(T0 + 2500).frames.map((f) => f.id)).toEqual(ids.slice(-10));
    expect(store.stats().evictedFrames).toBe(15);
    // A single frame over the cap is still kept (the screen right now).
    const tiny = new RollingFrameStore(opts({ maxBytes: 50 }));
    const big = tiny.addFrame(T0, jpeg(1, 500), meta);
    expect(tiny.view(T0).frames.map((f) => f.id)).toEqual([big]);
  });

  test("sample count is hard-capped at seconds x fps (plus slack) however fast ticks arrive", () => {
    const store = new RollingFrameStore(opts({ seconds: 2, fps: 2 }));
    store.addFrame(T0, jpeg(1), meta);
    for (let i = 1; i < 1000; i++) store.addRepeat(T0 + i); // 1 ms apart, all inside the window
    expect(store.stats().samples).toBeLessThanOrEqual(2 * 2 * 2);
  });

  test("frame lookup by id, by age, and latest", () => {
    const store = new RollingFrameStore(opts());
    const a = store.addFrame(T0, jpeg(1), meta);
    store.addRepeat(T0 + 1000);
    const b = store.addFrame(T0 + 2000, jpeg(2), meta);
    expect(store.frame(a)?.data[0]).toBe(1);
    expect(store.frame(999)).toBeUndefined();
    expect(store.latest()?.id).toBe(b);
    // 1.5 s before T0+2500 → sample at T0+1000 → still frame a.
    expect(store.frameAt(T0 + 1000)?.id).toBe(a);
    expect(store.frameAt(T0 + 2100)?.id).toBe(b);
    expect(store.frameAt(T0 - 1)).toBeUndefined();
  });

  test("view(since) keeps the samples in range and the frames they show", () => {
    const store = new RollingFrameStore(opts());
    const a = store.addFrame(T0, jpeg(1), meta);
    store.addRepeat(T0 + 1000);
    store.addRepeat(T0 + 2000);
    const b = store.addFrame(T0 + 3000, jpeg(2), meta);
    const view = store.view(T0 + 3000, { sinceMs: T0 + 1500 });
    expect(view.samples.map((s) => s.frame)).toEqual([a, b]);
    expect(view.frames.map((f) => f.id)).toEqual([a, b]);
    expect(view.samples[0]!.t).toBe(0);
    expect(view.origin).toBe(new Date(T0 + 2000).toISOString());
  });

  test("clear drops everything", () => {
    const store = new RollingFrameStore(opts());
    store.addFrame(T0, jpeg(1), meta);
    store.clear();
    expect(store.stats()).toMatchObject({ samples: 0, frames: 0, bytes: 0 });
  });
});

function hidEntry(id: number, at: number, overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id, timestamp: new Date(at).toISOString(), source: "hid", kind: "tap", summary: "Tap (0.50, 0.90)", msg: "Tap (0.50, 0.90)",
    device: "DEV", status: "ok", details: { x: 0.5, y: 0.9 }, ...overrides,
  } as EventLogEntry;
}

describe("event join", () => {
  test("events land on the buffer timeline with the frame shown and the next change", () => {
    const store = new RollingFrameStore(opts());
    const a = store.addFrame(T0, jpeg(1), meta);
    store.addRepeat(T0 + 250);
    store.addRepeat(T0 + 500);
    const b = store.addFrame(T0 + 750, jpeg(2), meta);
    store.addEvent(hidEntry(7, T0 + 300), T0 + 300);
    const [event] = store.view(T0 + 800).events;
    expect(event).toMatchObject({ id: 7, t: 0.3, kind: "tap", x: 0.5, y: 0.9, frame: a, nextChange: { frame: b, t: 0.75, after: 0.45 } });
  });

  test("an event with no later change has no nextChange; other devices and sources are ignored", () => {
    const store = new RollingFrameStore(opts(), "DEV");
    store.addFrame(T0, jpeg(1), meta);
    store.addEvent(hidEntry(1, T0 + 100), T0 + 100);
    store.addEvent(hidEntry(2, T0 + 100, { device: "OTHER" }), T0 + 100);
    store.addEvent(hidEntry(3, T0 + 100, { source: "exec" }), T0 + 100);
    const events = store.view(T0 + 200).events;
    expect(events.map((e) => e.id)).toEqual([1]);
    expect(events[0]!.nextChange).toBeUndefined();
  });

  test("a drag measures its next change from the last point", () => {
    const store = new RollingFrameStore(opts());
    store.addFrame(T0, jpeg(1), meta);
    store.addEvent(hidEntry(4, T0 + 100, { kind: "drag", details: { start: { x: 0.5, y: 0.8 }, current: { x: 0.5, y: 0.2 } } }), T0 + 100);
    store.addEvent(hidEntry(4, T0 + 100, { kind: "drag", details: { start: { x: 0.5, y: 0.8 }, current: { x: 0.5, y: 0.1 } } }), T0 + 600);
    const c = store.addFrame(T0 + 500, jpeg(2), meta); // during the drag: not "after" it
    const d = store.addFrame(T0 + 900, jpeg(3), meta);
    const [drag] = store.view(T0 + 1000).events;
    expect(drag).toMatchObject({ id: 4, t: 0.1, tEnd: 0.6, y: 0.1, nextChange: { frame: d, t: 0.9 } });
    expect(c).not.toBe(d);
  });

  test("updateEvent patches a collected event and moves its end; unknown ids are ignored", () => {
    const store = new RollingFrameStore(opts(), "DEV");
    store.addFrame(T0, jpeg(1), meta);
    store.addEvent(hidEntry(4, T0 + 100, { kind: "drag", details: { start: { x: 0.5, y: 0.8 }, current: { x: 0.5, y: 0.2 } } }), T0 + 100);
    store.updateEvent(4, { summary: "Drag to (0.50, 0.10)", details: { start: { x: 0.5, y: 0.8 }, current: { x: 0.5, y: 0.1 } } }, T0 + 700);
    store.updateEvent(99, { summary: "nope" }, T0 + 700);
    const d = store.addFrame(T0 + 900, jpeg(2), meta);
    const events = store.view(T0 + 1000).events;
    expect(events.map((e) => e.id)).toEqual([4]);
    expect(events[0]).toMatchObject({ tEnd: 0.7, y: 0.1, summary: "Drag to (0.50, 0.10)", nextChange: { frame: d, after: 0.2 } });
  });

  test("events older than the window are pruned and the count is capped", () => {
    const store = new RollingFrameStore(opts({ seconds: 5 }));
    store.addFrame(T0, jpeg(1), meta);
    store.addEvent(hidEntry(1, T0), T0);
    store.addRepeat(T0 + 6000);
    store.evict(T0 + 6000);
    expect(store.view(T0 + 6000).events).toEqual([]);
    for (let i = 0; i < 5000; i++) store.addEvent(hidEntry(100 + i, T0 + 6000), T0 + 6000);
    expect(store.stats().events).toBeLessThanOrEqual(1000);
  });
});

/** Manual clock + timer for the sampler. */
function harness(overrides: { count?: () => number | null; thumbnail?: () => Promise<ThumbnailFrame | null> } = {}) {
  let now = T0;
  let timer: (() => void) | null = null;
  let content = 0;
  const calls = { count: 0, thumbnail: 0 };
  let fill = 0;
  const sampler = new RollingBufferSampler({
    now: () => now,
    setTimer: (fn) => { timer = fn; return { clear: () => { if (timer === fn) timer = null; } }; },
    contentChangeCount: overrides.count ?? (() => { calls.count++; return content; }),
    thumbnail: overrides.thumbnail ?? (async () => { calls.thumbnail++; return { data: jpeg(fill), ...meta }; }),
  });
  return {
    sampler, calls,
    change(nextFill?: number) { content++; fill = nextFill ?? fill + 1; },
    setFill(f: number) { fill = f; },
    async tick(ms = 250) { now += ms; const fn = timer; timer = null; fn?.(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); },
    get armed() { return timer !== null; },
  };
}

describe("RollingBufferSampler", () => {
  test("off by default: no timer, no native calls", async () => {
    const h = harness();
    expect(h.sampler.enabled).toBe(false);
    await h.tick();
    expect(h.armed).toBe(false);
    expect(h.calls).toEqual({ count: 0, thumbnail: 0 });
  });

  test("noteEvent/updateEvent feed the running store and are no-ops while off", async () => {
    const h = harness();
    h.sampler.noteEvent(hidEntry(1, T0));
    h.sampler.updateEvent(1, { summary: "x" });
    expect(h.sampler.store).toBeNull();
    h.sampler.start(opts());
    await h.tick(0);
    h.sampler.noteEvent(hidEntry(1, T0, { kind: "drag" }));
    h.sampler.updateEvent(1, { summary: "Drag moved" });
    expect(h.sampler.store!.view(T0 + 100).events).toMatchObject([{ id: 1, summary: "Drag moved" }]);
    h.sampler.stop();
  });

  test("start captures the first frame, then only snapshots when the content counter moves", async () => {
    const h = harness();
    h.sampler.start(opts({ fps: 4 }));
    await h.tick(0);
    expect(h.calls.thumbnail).toBe(1);
    await h.tick();
    await h.tick();
    expect(h.calls.thumbnail).toBe(1); // unchanged: counter read only
    h.change();
    await h.tick();
    expect(h.calls.thumbnail).toBe(2);
    expect(h.sampler.store!.stats()).toMatchObject({ frames: 2, samples: 4, unchanged: 2 });
  });

  test("a snapshot identical to the last frame is stored as a repeat", async () => {
    const h = harness();
    h.sampler.start(opts());
    await h.tick(0);
    h.change(0); // counter moved but the pixels (and so the JPEG) are the same
    await h.tick();
    expect(h.calls.thumbnail).toBe(2);
    expect(h.sampler.store!.stats()).toMatchObject({ frames: 1, samples: 2, duplicates: 1 });
  });

  test("without a content counter every tick snapshots, deduped by bytes", async () => {
    const h = harness({ count: () => null });
    h.sampler.start(opts());
    await h.tick(0);
    await h.tick();
    expect(h.calls.thumbnail).toBe(2);
    expect(h.sampler.store!.stats()).toMatchObject({ frames: 1, samples: 2 });
  });

  test("ticks are paced at 1/fps from each tick's start", async () => {
    let now = T0;
    const delays: number[] = [];
    let pending: (() => void) | null = null;
    const sampler = new RollingBufferSampler({
      now: () => now,
      setTimer: (fn, ms) => { delays.push(ms); pending = fn; return { clear: () => {} }; },
      contentChangeCount: () => 0,
      // A 30 ms snapshot: the next tick is 200 - 30 ms away.
      thumbnail: async () => { now += 30; return { data: jpeg(1), ...meta }; },
    });
    sampler.start(opts({ fps: 5 }));
    (pending as unknown as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    (pending as unknown as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    expect(delays).toEqual([0, 170, 200]);
    // A frame is stamped when its snapshot resolved, not at the tick start.
    expect(sampler.store!.latest()!.atMs).toBe(T0 + 30);
    sampler.stop();
  });

  test("snapshot errors are counted, not thrown, and sampling continues", async () => {
    let fail = true;
    const h = harness({ thumbnail: async () => { if (fail) throw new Error("boom"); return { data: jpeg(9), ...meta }; } });
    h.sampler.start(opts());
    await h.tick(0);
    expect(h.sampler.store!.stats()).toMatchObject({ errors: 1, frames: 0, lastError: "boom" });
    fail = false;
    h.change();
    await h.tick();
    expect(h.sampler.store!.stats().frames).toBe(1);
  });

  test("stop clears the timer and frees the frames", async () => {
    const h = harness();
    h.sampler.start(opts());
    await h.tick(0);
    h.sampler.stop();
    expect(h.sampler.enabled).toBe(false);
    expect(h.sampler.store).toBeNull();
    const before = { ...h.calls };
    await h.tick();
    expect(h.calls).toEqual(before);
    expect(h.armed).toBe(false);
  });

  test("stop while a snapshot is in flight drops its result", async () => {
    let release!: (frame: ThumbnailFrame) => void;
    const h = harness({ thumbnail: () => new Promise((r) => { release = r; }) });
    h.sampler.start(opts());
    await h.tick(0);
    h.sampler.stop();
    release({ data: jpeg(1), ...meta });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sampler.store).toBeNull();
    expect(h.armed).toBe(false);
  });
});
