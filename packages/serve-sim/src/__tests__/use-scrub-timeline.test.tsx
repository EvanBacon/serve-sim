import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useScrubTimeline } from "../client/hooks/use-scrub-timeline";
import { useScreenRecording, type SavedRecording } from "../client/hooks/use-screen-recording";

type Call = { method: string; path: string };
type Handler = (call: Call) => Response | Promise<Response>;

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;
let dom: Window;
let root: Root | undefined;
let previous: Map<string, unknown>;
let realFetch: typeof fetch;
let calls: Call[];
let handler: Handler;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const BUFFER_VIEW = {
  enabled: true,
  origin: "2026-11-10T00:00:00.000Z",
  now: "2026-11-10T00:00:02.000Z",
  samples: [
    { t: 0, at: "", frame: 1, changed: true },
    { t: 1, at: "", frame: 2, changed: true },
  ],
  frames: [],
  events: [{ type: "event", t: 0.5, id: 4, timestamp: "", kind: "tap", summary: "Tap", x: 0.5, y: 0.5 }],
};

const SIDECAR = [
  { type: "header", version: 1, fps: 30, clock: null },
  { type: "frame", i: 0, pts: 0, uptime: 0, changed: true },
  { type: "frame", i: 1, pts: 0.5, uptime: 0.5, changed: true },
  { type: "event", t: 0.25, id: 9, timestamp: "", kind: "tap", summary: "Tap", x: 0.1, y: 0.2 },
  { type: "footer", durationSec: 1 },
].map((l) => JSON.stringify(l)).join("\n");

beforeEach(() => {
  dom = new Window({ url: "http://localhost/" });
  previous = new Map();
  for (const name of GLOBALS) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name];
  }
  (dom as unknown as { __SIM_PREVIEW__: unknown }).__SIM_PREVIEW__ = { basePath: "/" };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  handler = () => json({ enabled: false });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { method: (init?.method ?? "GET").toUpperCase(), path: String(input) };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  globalThis.fetch = realFetch;
  await dom.happyDOM.abort();
  for (const name of GLOBALS) {
    const prior = previous.get(name);
    if (prior === undefined) delete (globalThis as Record<string, unknown>)[name];
    else (globalThis as Record<string, unknown>)[name] = prior;
  }
});

async function flush(ms = 5) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

describe("useScrubTimeline", () => {
  let hook: ReturnType<typeof useScrubTimeline>;
  function Harness(props: { device: string; open: boolean; saved?: SavedRecording | null; pollMs: number }) {
    hook = useScrubTimeline(props);
    return null;
  }
  async function render(props: { device?: string; open: boolean; saved?: SavedRecording | null; pollMs?: number }) {
    await act(async () => {
      root ??= createRoot(dom.document.createElement("div") as unknown as HTMLElement);
      root.render(<Harness device={props.device ?? "A"} open={props.open} saved={props.saved} pollMs={props.pollMs ?? 60_000} />);
    });
    await flush();
  }

  test("closed, it makes no requests", async () => {
    await render({ open: false, pollMs: 10 });
    await flush(40);
    expect(calls).toEqual([]);
    expect(hook.source).toBeNull();
    expect(hook.position).toBeNull();
  });

  test("open with the buffer off reports off and has no source", async () => {
    await render({ open: true });
    expect(calls).toEqual([{ method: "GET", path: "/helper/A/buffer" }]);
    expect(hook.bufferStatus).toBe("off");
    expect(hook.source).toBeNull();
  });

  test("open with the buffer on builds a source and follows it until a seek", async () => {
    handler = () => json(BUFFER_VIEW);
    await render({ open: true, pollMs: 10 });
    expect(hook.bufferStatus).toBe("on");
    expect(hook.source?.kind).toBe("buffer");
    expect(hook.source?.duration).toBe(2);
    expect(hook.source?.markers.map((m) => m.id)).toEqual([4]);

    await act(async () => { hook.seek(0.7); });
    expect(hook.position).toBe(0.7);
    const frozenAt = calls.length;
    await flush(40);
    expect(calls.length).toBe(frozenAt); // frozen while scrubbing

    await act(async () => { hook.seek(5); });
    expect(hook.position).toBe(2); // clamped to the track

    await act(async () => { hook.seek(null); });
    await flush(40);
    expect(hook.position).toBeNull();
    expect(calls.length).toBeGreaterThan(frozenAt); // live again
  });

  test("closing the timeline returns to live", async () => {
    handler = () => json(BUFFER_VIEW);
    await render({ open: true });
    await act(async () => { hook.seek(1); });
    await render({ open: false });
    expect(hook.position).toBeNull();
    expect(hook.playing).toBe(false);
  });

  test("buffer playback advances at 1x from 0 and stops at the end", async () => {
    const frames: FrameRequestCallback[] = [];
    const g = globalThis as Record<string, unknown>;
    const prior = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
    g.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb);
    g.cancelAnimationFrame = () => {};
    const start = performance.now();
    const step = async (at: number) => {
      const cb = frames.shift();
      await act(async () => { cb?.(start + at); });
    };
    try {
      handler = () => json(BUFFER_VIEW);
      await render({ open: true });
      await act(async () => { hook.togglePlaying(); });
      expect(hook.playing).toBe(true);
      expect(hook.position).toBe(0);
      await step(500);
      expect(hook.position).toBeCloseTo(0.5, 1);
      await act(async () => { hook.seek(1.5); }); // a seek while playing is adopted
      await step(600);
      expect(hook.position).toBeCloseTo(1.6, 1);
      await step(3000);
      expect(hook.position).toBe(2);
      expect(hook.playing).toBe(false);
      await act(async () => { hook.togglePlaying(); }); // from the end: restart
      expect(hook.position).toBe(0);
      await act(async () => { hook.togglePlaying(); });
      expect(hook.playing).toBe(false);
    } finally {
      g.requestAnimationFrame = prior.raf;
      g.cancelAnimationFrame = prior.caf;
    }
  });

  test("Start buffer posts /buffer/start", async () => {
    await render({ open: true });
    await act(async () => { await hook.startBuffer(); });
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/helper/A/buffer/start" });
  });

  test("a saved recording loads its sidecar and becomes the source", async () => {
    handler = ({ path }) => path.includes("/recording/index")
      ? new Response(SIDECAR, { status: 200 })
      : json({ enabled: false });
    const saved: SavedRecording = { device: "A", token: "tok", fileName: "rec.mp4", blob: new Blob(["x"], { type: "video/mp4" }) };
    await render({ open: true, saved });
    expect(calls.some((c) => c.path === "/helper/A/recording/index?token=tok&file=rec.mp4")).toBe(true);
    expect(hook.sourceKind).toBe("recording");
    expect(hook.recording?.fileName).toBe("rec.mp4");
    expect(hook.recording?.videoUrl).toStartWith("blob:");
    expect(hook.source?.frames.map((f) => f.t)).toEqual([0, 0.5]);
    expect(hook.source?.markers.map((m) => m.id)).toEqual([9]);
    expect(hook.position).toBeNull(); // stays live until the user scrubs

    await act(async () => { hook.closeRecording(); });
    expect(hook.recording).toBeNull();
    expect(hook.sourceKind).toBe("buffer");
  });

  test("a saved recording for another device is ignored", async () => {
    const saved: SavedRecording = { device: "B", token: "tok", fileName: "rec.mp4", blob: new Blob(["x"]) };
    await render({ open: true, saved });
    expect(calls.some((c) => c.path.includes("/recording/index"))).toBe(false);
  });

  test("openFiles needs both the MP4 and its index", async () => {
    await render({ open: true });
    const mp4 = new File(["x"], "rec.mp4", { type: "video/mp4" });
    const index = new File([SIDECAR], "rec.index.jsonl");
    let ok = true;
    await act(async () => { ok = await hook.openFiles([mp4]); });
    expect(ok).toBe(false);
    expect(hook.recording).toBeNull();
    await act(async () => { ok = await hook.openFiles([index, mp4]); });
    expect(ok).toBe(true);
    expect(hook.recording?.fileName).toBe("rec.mp4");
    expect(hook.source?.duration).toBe(1);
  });

  test("a malformed index is rejected", async () => {
    await render({ open: true });
    let ok = true;
    await act(async () => {
      ok = await hook.openFiles([new File(["x"], "rec.mp4", { type: "video/mp4" }), new File(["nope"], "rec.index.jsonl")]);
    });
    expect(ok).toBe(false);
    expect(hook.recording).toBeNull();
  });
});

describe("useScreenRecording index opt-in", () => {
  let hook: ReturnType<typeof useScreenRecording>;
  let saved: SavedRecording[];
  function Harness({ index }: { index: boolean }) {
    hook = useScreenRecording("A", { pollMs: 60_000, index, onSaved: (s) => saved.push(s) });
    return null;
  }
  async function render(index: boolean) {
    await act(async () => {
      root ??= createRoot(dom.document.createElement("div") as unknown as HTMLElement);
      root.render(<Harness index={index} />);
    });
    await flush();
  }

  beforeEach(() => {
    saved = [];
    // The hook downloads via a temporary <a>; happy-dom's URL helpers are enough.
    handler = ({ method, path }) => {
      if (method === "POST" && path.includes("/recording/start")) return json({ recording: true, startedAt: "2026-11-10T00:00:00.000Z", token: "tok" });
      if (method === "POST" && path.includes("/recording/stop")) {
        return new Response("mp4", { status: 200, headers: { "content-type": "video/mp4", "content-disposition": 'attachment; filename="rec.mp4"' } });
      }
      return json({ recording: false });
    };
  });

  test("off (the default path): no index param, no onSaved", async () => {
    await render(false);
    await act(async () => { await hook.start(); });
    await act(async () => { await hook.stop(); });
    expect(calls.find((c) => c.method === "POST" && c.path.includes("/start"))?.path).toBe("/helper/A/recording/start");
    expect(calls.find((c) => c.method === "POST" && c.path.includes("/stop"))?.path).toBe("/helper/A/recording/stop?token=tok");
    expect(saved).toEqual([]);
  });

  test("on: starts with index=1 and hands the saved MP4 + token over", async () => {
    await render(true);
    await act(async () => { await hook.start(); });
    await act(async () => { await hook.stop(); });
    expect(calls.find((c) => c.method === "POST" && c.path.includes("/start"))?.path).toBe("/helper/A/recording/start?index=1");
    expect(saved.length).toBe(1);
    expect(saved[0]).toMatchObject({ device: "A", token: "tok", fileName: "rec.mp4" });
    expect(await saved[0]!.blob.text()).toBe("mp4");
  });
});

describe("ScrubTimeline (container)", () => {
  test("scrubbing portals the buffer frame over the screen; Esc goes back to live", async () => {
    const { ScrubTimeline } = await import("../client/components/scrub-timeline");
    handler = ({ path }) => path.includes("/buffer/frame")
      ? new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } })
      : json(BUFFER_VIEW);
    const doc = dom.document;
    const screen = doc.createElement("div") as unknown as HTMLElement;
    const bar = doc.createElement("div") as unknown as HTMLElement;
    doc.body.appendChild(screen as never);
    doc.body.appendChild(bar as never);
    await act(async () => {
      root = createRoot(bar);
      root.render(<ScrubTimeline device="A" open overlayTarget={screen} />);
    });
    await flush();
    expect(bar.querySelector('[data-marker-kind="tap"]')).not.toBeNull();
    expect(screen.querySelector('[data-testid="scrub-frame-overlay"]')).toBeNull();

    const track = bar.querySelector('[role="slider"]')!;
    await act(async () => {
      track.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await flush();
    // From live, one frame back is the oldest sample (frame 1, t = 0).
    expect(calls.some((c) => c.path === "/helper/A/buffer/frame?id=1")).toBe(true);
    const overlay = screen.querySelector('[data-testid="scrub-frame-overlay"]')!;
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector("img")?.getAttribute("src")).toStartWith("blob:");
    expect(overlay.textContent).toContain("buffer · −2.0s");

    await act(async () => {
      track.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
    });
    expect(screen.querySelector('[data-testid="scrub-frame-overlay"]')).toBeNull();
  });

  test("closed, it renders nothing and fetches nothing", async () => {
    const { ScrubTimeline } = await import("../client/components/scrub-timeline");
    const bar = dom.document.createElement("div") as unknown as HTMLElement;
    await act(async () => {
      root = createRoot(bar);
      root.render(<ScrubTimeline device="A" open={false} overlayTarget={null} />);
    });
    await flush(20);
    expect(bar.innerHTML).toBe("");
    expect(calls).toEqual([]);
  });
});
