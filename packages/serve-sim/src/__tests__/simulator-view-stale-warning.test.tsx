import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SimulatorView } from "../client/simulator/SimulatorView";
import { createStreamReadStats, type StreamReadStats } from "../client/utils/stream-stale-diagnostics";

// Relay mode (the LAN / MJPEG-in-JS path of #103): when the 2 s staleness
// check flips the pill to connecting, one `[serve-sim] stream stale` warning
// per episode records what the reader saw.

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "ResizeObserver"] as const;

let dom: Window;
let root: Root | undefined;
let container: HTMLElement;
let previous: Map<string, unknown>;
let warn: ReturnType<typeof spyOn>;
let realRaf: unknown;
let realCaf: unknown;

beforeEach(() => {
  dom = new Window({ url: "http://localhost/" });
  previous = new Map();
  for (const name of GLOBALS) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name];
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  realRaf = (globalThis as Record<string, unknown>).requestAnimationFrame;
  realCaf = (globalThis as Record<string, unknown>).cancelAnimationFrame;
  (globalThis as Record<string, unknown>).requestAnimationFrame = () => 0;
  (globalThis as Record<string, unknown>).cancelAnimationFrame = () => {};
  container = dom.document.createElement("div") as unknown as HTMLElement;
  warn = spyOn(console, "warn").mockImplementation(() => {});
  jest.useFakeTimers();
});

afterEach(async () => {
  jest.useRealTimers();
  await act(async () => { root?.unmount(); });
  root = undefined;
  warn.mockRestore();
  (globalThis as Record<string, unknown>).requestAnimationFrame = realRaf;
  (globalThis as Record<string, unknown>).cancelAnimationFrame = realCaf;
  await dom.happyDOM.abort();
  for (const name of GLOBALS) {
    const prior = previous.get(name);
    if (prior === undefined) delete (globalThis as Record<string, unknown>)[name];
    else (globalThis as Record<string, unknown>)[name] = prior;
  }
});

const staleWarnings = () => warn.mock.calls.filter((args: unknown[]) => args[0] === "[serve-sim] stream stale");

async function renderRelay(stats: StreamReadStats) {
  let onFrame: ((blobUrl: string) => void) | undefined;
  const subscribeFrame = (cb: (blobUrl: string) => void) => {
    onFrame = cb;
    return () => { onFrame = undefined; };
  };
  await act(async () => {
    root = createRoot(container);
    root.render(
      <SimulatorView
        url="http://sim.test/helper/ABC"
        codec="mjpeg"
        hideControls
        onStreamTouch={() => {}}
        subscribeFrame={subscribeFrame}
        streamStats={stats}
      />,
    );
  });
  return {
    frame: async () => {
      stats.frames++;
      stats.lastFrameAt = Date.now();
      await act(async () => { onFrame!(`blob:frame-${stats.frames}`); });
    },
  };
}

async function advance(ms: number) {
  await act(async () => { jest.advanceTimersByTime(ms); });
}

describe("SimulatorView relay stale-stream warning", () => {
  test("no warning while frames keep arriving", async () => {
    const view = await renderRelay(createStreamReadStats());
    for (let i = 0; i < 6; i++) {
      await view.frame();
      await advance(1000);
    }
    expect(staleWarnings()).toHaveLength(0);
  });

  test("warns once per stale episode, with the reader's state", async () => {
    const stats = createStreamReadStats();
    const view = await renderRelay(stats);
    await view.frame();
    stats.bytes = 12_345;
    stats.lastChunkAt = Date.now();
    stats.bufferedBytes = 77;
    stats.readPending = true;
    stats.connections = 1;

    await advance(1000);
    expect(staleWarnings()).toHaveLength(0);
    await advance(2000);
    expect(staleWarnings()).toHaveLength(1);
    const details = staleWarnings()[0]![1] as Record<string, unknown>;
    expect(details).toMatchObject({
      path: "mjpeg-js",
      bytes: 12_345,
      frames: 1,
      bufferedBytes: 77,
      readPending: true,
      connections: 1,
      hidden: false,
    });
    expect(details.msSinceLastChunk as number).toBeGreaterThan(2000);
    expect(details.msSinceLastFrame as number).toBeGreaterThan(2000);

    // Still stale: more ticks and a visibility change do not warn again.
    await advance(10_000);
    await act(async () => { dom.document.dispatchEvent(new dom.Event("visibilitychange")); });
    expect(staleWarnings()).toHaveLength(1);

    // A frame ends the episode; the next stall warns again.
    await view.frame();
    await advance(1000);
    expect(staleWarnings()).toHaveLength(1);
    await advance(3000);
    expect(staleWarnings()).toHaveLength(2);
  });
});
