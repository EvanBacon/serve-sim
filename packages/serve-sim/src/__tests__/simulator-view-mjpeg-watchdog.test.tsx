import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SimulatorView } from "../client/simulator/SimulatorView";

// Direct (non-relay) MJPEG mode renders `<img src=".../stream.mjpeg">` and
// also opens a second `fetch()` of the same endless stream to count frames.
// That second consumer can stall on its own — it is blocked by CORS when the
// view is embedded cross-origin, or queued behind the browser's per-host
// connection limit when several streams are open — while the visible <img>
// keeps painting frames (#128).

const STALL_TEXT = "Stream is not producing frames";
const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "ResizeObserver"] as const;

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }
  send() {}
  close() { this.readyState = 3; }
}

let dom: Window;
let root: Root | undefined;
let container: HTMLElement;
let previous: Map<string, unknown>;
let realFetch: typeof fetch;
let realWebSocket: unknown;
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  dom = new Window({ url: "http://localhost/" });
  previous = new Map();
  for (const name of GLOBALS) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name];
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    fetchImpl(String(input), init)) as typeof fetch;
  container = dom.document.createElement("div") as unknown as HTMLElement;
  jest.useFakeTimers();
});

afterEach(async () => {
  jest.useRealTimers();
  await act(async () => { root?.unmount(); });
  root = undefined;
  globalThis.fetch = realFetch;
  (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
  await dom.happyDOM.abort();
  for (const name of GLOBALS) {
    const prior = previous.get(name);
    if (prior === undefined) delete (globalThis as Record<string, unknown>)[name];
    else (globalThis as Record<string, unknown>)[name] = prior;
  }
});

/** fetch() that never settles — e.g. queued behind the per-host connection limit. */
const pendingFetch = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

/** A 200 multipart response whose body never emits a byte (dead simulator). */
const silentStream = (_url: string, init?: RequestInit) => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
  return Promise.resolve(new Response(body, { status: 200 }));
};

async function render() {
  await act(async () => {
    root = createRoot(container);
    root.render(<SimulatorView url="http://sim.test/helper/ABC" codec="mjpeg" hideControls />);
  });
}

/** Simulate the visible <img> decoding an MJPEG part. */
async function paintImageFrame() {
  const img = container.querySelector("img") as unknown as HTMLImageElement & { naturalWidth: number; naturalHeight: number };
  expect(img).toBeTruthy();
  expect(img.getAttribute("src")).toBe("http://sim.test/helper/ABC/stream.mjpeg");
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: 1640 });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: 2360 });
  await act(async () => {
    img.dispatchEvent(new dom.Event("load") as unknown as Event);
  });
}

async function advance(ms: number) {
  await act(async () => { jest.advanceTimersByTime(ms); });
}

const text = () => container.textContent ?? "";

describe("SimulatorView direct MJPEG startup watchdog", () => {
  test("does not report a stall while the visible <img> is painting frames", async () => {
    fetchImpl = pendingFetch;
    await render();
    await paintImageFrame();
    await advance(6500);
    expect(text()).not.toContain(STALL_TEXT);
  });

  test("does not report a stall when the side fetch is blocked (CORS) but the <img> streams", async () => {
    fetchImpl = () => Promise.reject(new TypeError("Failed to fetch"));
    await render();
    await advance(1000);
    await paintImageFrame();
    await advance(6000);
    expect(text()).not.toContain(STALL_TEXT);
  });

  test("a late first image frame clears the stall overlay", async () => {
    fetchImpl = pendingFetch;
    await render();
    await advance(6500);
    expect(text()).toContain(STALL_TEXT);
    await paintImageFrame();
    expect(text()).not.toContain(STALL_TEXT);
  });

  test("still reports a genuine stall when no frame ever arrives", async () => {
    fetchImpl = silentStream;
    await render();
    await advance(5900);
    expect(text()).not.toContain(STALL_TEXT);
    await advance(200);
    expect(text()).toContain(STALL_TEXT);
  });

  test("a frame boundary on the side fetch still satisfies the watchdog", async () => {
    fetchImpl = (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("--frame\r\nContent-Type: image/jpeg\r\n\r\n"));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    await render();
    await advance(6500);
    expect(text()).not.toContain(STALL_TEXT);
  });
});
