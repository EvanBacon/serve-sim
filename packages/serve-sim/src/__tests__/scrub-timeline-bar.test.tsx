import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ScrubFrameOverlay,
  ScrubTimelineBar,
  ScrubTimelineToolbarButton,
  type ScrubTimelineBarProps,
} from "../client/components/scrub-timeline";
import { SimulatorToolbar } from "../client/simulator/SimulatorToolbar";
import type { TimelineSource } from "../client/utils/scrub-timeline";

const SOURCE: TimelineSource = {
  kind: "recording",
  duration: 1,
  fps: 10,
  frames: [0, 0.1, 0.2, 0.3, 0.4, 0.5].map((t, i) => ({ t, frame: i, changed: i % 2 === 0 })),
  markers: [
    { id: 1, t: 0.15, kind: "tap", rawKind: "tap", summary: "Tap 0.25, 0.5", x: 0.25, y: 0.5 },
    { id: 2, t: 0.35, tEnd: 0.45, kind: "drag", rawKind: "drag", summary: "Drag", x: 0.5, y: 0.2, start: { x: 0.5, y: 0.8 } },
    { id: 3, t: 0.6, kind: "other", rawKind: "button", summary: "Button home" },
  ],
};

type Calls = { seek: Array<number | null>; toggle: number; pause: number; focus: Array<number | null>; source: string[]; startBuffer: number };

function propsFor(overrides: Partial<ScrubTimelineBarProps> = {}, calls?: Calls): ScrubTimelineBarProps {
  return {
    source: SOURCE,
    sourceKind: "recording",
    position: null,
    playing: false,
    bufferStatus: "on",
    hasBuffer: true,
    recordingName: "serve-sim-recording.mp4",
    onSeek: (t) => calls?.seek.push(t),
    onTogglePlay: () => { if (calls) calls.toggle++; },
    onPause: () => { if (calls) calls.pause++; },
    onSelectSource: (kind) => calls?.source.push(kind),
    onStartBuffer: () => { if (calls) calls.startBuffer++; },
    onOpenFiles: () => {},
    onCloseRecording: () => {},
    onFocusMarker: (id) => calls?.focus.push(id),
    ...overrides,
  };
}

describe("ScrubTimelineBar (static)", () => {
  test("draws one marker per event with its kind, time, and point", () => {
    const html = renderToStaticMarkup(<ScrubTimelineBar {...propsFor()} />);
    expect(html).toContain('data-marker-kind="tap"');
    expect(html).toContain('data-marker-kind="drag"');
    expect(html).toContain('data-marker-kind="other"');
    expect(html).toContain('aria-label="tap · 0:00.15 · at 25%, 50%"');
    expect(html).toContain('aria-label="drag · 0:00.35–0:00.45 · 50%, 80% → 50%, 20%"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuetext="Live of 0:01.00"');
  });

  test("live hides the playhead; a position shows it and the time", () => {
    expect(renderToStaticMarkup(<ScrubTimelineBar {...propsFor()} />)).not.toContain("scrub-playhead");
    const html = renderToStaticMarkup(<ScrubTimelineBar {...propsFor({ position: 0.25 })} />);
    expect(html).toContain("scrub-playhead");
    expect(html).toContain("left:25%");
    expect(html).toContain("0:00.25 / 0:01.00");
  });

  test("a focused marker shows its details", () => {
    const html = renderToStaticMarkup(<ScrubTimelineBar {...propsFor({ focusedMarkerId: 3 })} />);
    expect(html).toContain('data-testid="scrub-marker-detail"');
    expect(html).toContain("button · 0:00.60");
  });

  test("buffer off offers to start it instead of a track", () => {
    const html = renderToStaticMarkup(
      <ScrubTimelineBar {...propsFor({ source: null, sourceKind: "buffer", bufferStatus: "off", hasBuffer: false, recordingName: null })} />,
    );
    expect(html).toContain("Buffer is off.");
    expect(html).toContain("Start buffer");
    expect(html).not.toContain('role="slider"');
    expect(html).not.toContain('role="radiogroup"');
  });

  test("toolbar toggle reflects open state", () => {
    const exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const html = renderToStaticMarkup(
      <SimulatorToolbar exec={exec} deviceUdid="booted" streaming>
        <ScrubTimelineToolbarButton open onToggle={() => {}} />
      </SimulatorToolbar>,
    );
    expect(html).toContain('aria-label="Hide timeline"');
    expect(html).toContain('aria-pressed="true"');
  });
});

describe("ScrubFrameOverlay (static)", () => {
  test("shows the buffer frame and a ring where the tap landed", () => {
    const html = renderToStaticMarkup(
      <ScrubFrameOverlay kind="buffer" imageUrl="blob:frame" marker={SOURCE.markers[0]} label="buffer · −1.0s" />,
    );
    expect(html).toContain('src="blob:frame"');
    expect(html).toContain("scrub-frame-marker");
    expect(html).toContain("left:25%");
    expect(html).toContain("top:50%");
    expect(html).toContain("buffer · −1.0s");
  });

  test("draws a drag's path and flags an evicted frame", () => {
    const html = renderToStaticMarkup(
      <ScrubFrameOverlay kind="buffer" imageUrl={null} marker={SOURCE.markers[1]} label="x" missing />,
    );
    expect(html).toContain("<line");
    expect(html).toContain("frame evicted");
    expect(html).not.toContain("<img");
  });

  test("a recording renders a muted video", () => {
    const html = renderToStaticMarkup(<ScrubFrameOverlay kind="recording" videoUrl="blob:mp4" label="x" />);
    expect(html).toContain("<video");
    expect(html).toContain('src="blob:mp4"');
  });
});

describe("ScrubTimelineBar (keyboard and pointer)", () => {
  const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "KeyboardEvent", "MouseEvent"] as const;
  let dom: Window;
  let root: Root | undefined;
  let previous: Map<string, unknown>;
  let host: HTMLElement;
  let calls: Calls;
  let windowKeys: string[];

  beforeEach(() => {
    dom = new Window({ url: "http://localhost/" });
    previous = new Map();
    for (const name of GLOBALS) {
      previous.set(name, (globalThis as Record<string, unknown>)[name]);
      (globalThis as Record<string, unknown>)[name] = name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name];
    }
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    calls = { seek: [], toggle: 0, pause: 0, focus: [], source: [], startBuffer: 0 };
    windowKeys = [];
    dom.addEventListener("keydown", (e) => windowKeys.push((e as unknown as KeyboardEvent).key));
    host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    await dom.happyDOM.abort();
    for (const name of GLOBALS) {
      const prior = previous.get(name);
      if (prior === undefined) delete (globalThis as Record<string, unknown>)[name];
      else (globalThis as Record<string, unknown>)[name] = prior;
    }
  });

  async function render(overrides: Partial<ScrubTimelineBarProps> = {}) {
    await act(async () => {
      root ??= createRoot(host);
      root.render(<ScrubTimelineBar {...propsFor(overrides, calls)} />);
    });
  }

  function press(key: string, init: { shiftKey?: boolean; metaKey?: boolean } = {}) {
    const track = host.querySelector('[role="slider"]')!;
    act(() => {
      track.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }) as unknown as Event);
    });
  }

  test("arrows step one frame from the playhead and stay off the simulator", async () => {
    await render({ position: 0.25 });
    press("ArrowRight");
    press("ArrowLeft");
    expect(calls.seek).toEqual([0.3, 0.1]);
    expect(windowKeys).toEqual([]);
  });

  test("arrows from live step back from the newest frame", async () => {
    await render();
    press("ArrowLeft");
    expect(calls.seek).toEqual([0.4]);
  });

  test("shift+arrows jump between markers and show the marker", async () => {
    await render({ position: 0.2 });
    press("ArrowRight", { shiftKey: true });
    expect(calls.seek).toEqual([0.35]);
    expect(calls.focus).toEqual([2]);
    press("ArrowLeft", { shiftKey: true });
    expect(calls.seek.at(-1)).toBe(0.15);
  });

  test("space toggles playback, Home/End jump, Esc returns to live", async () => {
    await render({ position: 0.25 });
    press(" ");
    press("Home");
    press("End");
    press("Escape");
    expect(calls.toggle).toBe(1);
    expect(calls.seek).toEqual([0, 0.5, null]);
    expect(windowKeys).toEqual([]);
  });

  test("keys it doesn't own still reach the page (and Esc while live)", async () => {
    await render();
    press("ArrowLeft", { metaKey: true });
    press("a");
    press("Escape");
    expect(calls.seek).toEqual([]);
    expect(windowKeys).toEqual(["ArrowLeft", "a", "Escape"]);
  });

  test("clicking a marker seeks to it and shows it", async () => {
    await render();
    const marker = host.querySelector('[data-marker-id="3"]') as HTMLButtonElement;
    act(() => { marker.click(); });
    expect(calls.seek).toEqual([0.6]);
    expect(calls.focus).toEqual([3]);
    expect(calls.pause).toBe(1);
  });

  test("the source switch and Start buffer call back", async () => {
    await render();
    const radios = host.querySelectorAll('[role="radio"]');
    act(() => { (radios[0] as HTMLButtonElement).click(); });
    expect(calls.source).toEqual(["buffer"]);
    await render({ source: null, sourceKind: "buffer", bufferStatus: "off", hasBuffer: false, recordingName: null });
    const start = [...host.querySelectorAll("button")].find((b) => b.textContent === "Start buffer")!;
    act(() => { start.click(); });
    expect(calls.startBuffer).toBe(1);
  });
});
