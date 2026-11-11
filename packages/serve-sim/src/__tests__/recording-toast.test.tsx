import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, isValidElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { toast as sonnerToast } from "sonner";
import {
  RECORDING_TOAST_COPY,
  SCREENSHOT_TOAST_COPY,
  ScreenshotToast,
} from "../client/components/screenshot-toast";
import {
  useRecordingToast,
  useScreenshotToast,
  type ScreenshotToast as ToastState,
} from "../client/hooks/use-screenshot-toast";
import * as execModule from "../client/utils/exec";
import type { HostActionFn } from "../client/utils/exec";
import { fitThumbSize, posterTime } from "../client/utils/video-frame-thumbnail";

// Record what the card asks the host to do. mock.module is process-wide, so
// the stand-in delegates to the real hostAction outside this file's tests.
const realExec = { ...execModule };
let hostActionImpl: HostActionFn = realExec.hostAction;
mock.module("../client/utils/exec", () => ({
  ...realExec,
  hostAction: (method: string, params?: Record<string, unknown>) => hostActionImpl(method, params),
}));
let hostCalls: Array<[string, Record<string, unknown> | undefined]>;
let hostReplies: Record<string, Record<string, unknown>>;

const noop = () => {};
const NAME = "serve-sim-recording-2026-11-11-12-30-00.mp4";
const PATH = `/Users/x/Downloads/${NAME}`;

function card(toast: ToastState): string {
  return renderToStaticMarkup(
    <ScreenshotToast toast={toast} onReveal={noop} onDismiss={noop} onPause={noop} onResume={noop} />,
  );
}

describe("capture card copy", () => {
  test("screenshots keep their copy when no copy is passed", () => {
    const html = card({ id: "1", status: "saved", phase: "in", path: "/Users/x/Desktop/shot.png" });
    expect(html).toContain("Screenshot Saved");
    expect(html).toContain("Open in Finder");
    expect(html).toContain('aria-label="Open screenshot in Finder"');
    expect(card({ id: "1", status: "saving", phase: "in" })).toContain("Saving Screenshot…");
    expect(card({ id: "1", status: "error", phase: "in" })).toContain("Screenshot failed");
    expect(SCREENSHOT_TOAST_COPY.savedTitle).toBe("Screenshot Saved");
  });

  test("recordings use the same card with their own title", () => {
    const html = card({
      id: "1",
      status: "saved",
      phase: "in",
      path: PATH,
      thumb: "data:image/jpeg;base64,AAAA",
      copy: RECORDING_TOAST_COPY,
    });
    expect(html).toContain('data-testid="screenshot-toast"');
    expect(html).toContain("Recording Saved");
    expect(html).toContain("Open in Finder");
    expect(html).toContain('aria-label="Open recording in Finder"');
    expect(html).toContain('src="data:image/jpeg;base64,AAAA"');
    expect(html).not.toContain("Screenshot");
  });
});

describe("video frame thumbnail sizing", () => {
  test("fits the longest edge and never upscales", () => {
    expect(fitThumbSize(1206, 2622)).toEqual({ width: 147, height: 320 });
    expect(fitThumbSize(2622, 1206)).toEqual({ width: 320, height: 147 });
    expect(fitThumbSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(fitThumbSize(0, 50)).toEqual({ width: 0, height: 0 });
  });

  test("grabs the last frame, or the first when the duration is unknown or tiny", () => {
    expect(posterTime(4)).toBeCloseTo(3.9);
    expect(posterTime(0.05)).toBe(0);
    expect(posterTime(Number.NaN)).toBe(0);
    expect(posterTime(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;
let dom: Window;
let root: Root | undefined;
let previous: Map<string, unknown>;
let hook: { dismiss: () => void } | undefined;

beforeEach(() => {
  dom = new Window({ url: "http://localhost/" });
  previous = new Map();
  for (const name of GLOBALS) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name];
  }
  // Sonner defers dismiss notifications to the next frame.
  previous.set("requestAnimationFrame", globalThis.requestAnimationFrame);
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { setTimeout(() => cb(0), 0); return 0; };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  hostCalls = [];
  hostReplies = {};
  hostActionImpl = async (method, params) => {
    hostCalls.push([method, params]);
    return { stdout: "", stderr: "", exitCode: 0, ...hostReplies[method] };
  };
});

afterEach(async () => {
  // Dismiss through the hook so its auto-dismiss timer can't fire after this
  // file's globals are gone (it would land in another test file).
  await act(async () => { hook?.dismiss(); });
  hook = undefined;
  hostActionImpl = realExec.hostAction;
  await flush();
  await act(async () => { root?.unmount(); });
  root = undefined;
  sonnerToast.dismiss();
  await dom.happyDOM.abort();
  for (const name of [...GLOBALS, "requestAnimationFrame"]) {
    const prior = previous.get(name);
    if (prior === undefined) delete (globalThis as Record<string, unknown>)[name];
    else (globalThis as Record<string, unknown>)[name] = prior;
  }
});

let recording: ReturnType<typeof useRecordingToast>;
let screenshot: ReturnType<typeof useScreenshotToast>;

function Harness(props: Parameters<typeof useRecordingToast>[0]) {
  hook = recording = useRecordingToast(props);
  return null;
}

function ScreenshotHarness() {
  hook = screenshot = useScreenshotToast("UDID-1");
  return null;
}

async function mount(props: Parameters<typeof useRecordingToast>[0], node = <Harness {...props} />) {
  await act(async () => {
    root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    root.render(node);
  });
}

const reveals = (method: string) => hostCalls.filter(([m]) => m === method);

async function flush(ms = 5) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

/** The props of the card Sonner is currently holding for the recording toast. */
function shownCard(): ToastState | null {
  const active = sonnerToast.getToasts().filter((t) => "jsx" in t && t.jsx) as Array<{ jsx: ReactNode }>;
  const el = active.at(-1)?.jsx;
  return isValidElement(el) ? (el.props as { toast: ToastState }).toast : null;
}

describe("useRecordingToast", () => {
  test("shows the card at once, then fills in the frame thumbnail and the located path", async () => {
    let releaseThumb!: (thumb: string) => void;
    const located: string[] = [];
    let tries = 0;
    await mount({
      thumbnail: () => new Promise((resolve) => { releaseThumb = resolve; }),
      locate: async (fileName) => {
        located.push(fileName);
        return ++tries < 2 ? "" : PATH; // still downloading on the first try
      },
      locateRetryMs: 1,
    });
    const blob = new Blob(["mp4"], { type: "video/mp4" });
    await act(async () => { recording.show({ fileName: NAME, blob }); });

    let shown = shownCard();
    expect(shown).toMatchObject({ status: "saved", fileName: NAME, copy: RECORDING_TOAST_COPY });
    expect(shown?.thumb).toBeUndefined();

    await flush(20);
    expect(located).toEqual([NAME, NAME]);
    expect(shownCard()?.path).toBe(PATH);

    await act(async () => { releaseThumb("data:image/jpeg;base64,BBBB"); });
    await flush();
    shown = shownCard();
    expect(shown).toMatchObject({ path: PATH, thumb: "data:image/jpeg;base64,BBBB" });
    expect(card(shown!)).toContain("Recording Saved");
  });

  test("keeps the card when there is no thumbnail and the file can't be found yet", async () => {
    const located: string[] = [];
    await mount({
      thumbnail: async () => undefined,
      locate: async (fileName) => { located.push(fileName); return ""; },
      locateRetryMs: 1,
    });
    await act(async () => { recording.show({ fileName: NAME, blob: new Blob(["x"]) }); });
    await flush(40);
    const shown = shownCard();
    expect(shown).toMatchObject({ status: "saved", fileName: NAME });
    expect(shown?.path).toBeUndefined();
    expect(shown?.thumbFailed).toBe(true);
    expect(card(shown!)).toContain('data-testid="thumb-placeholder"');
    expect(card(shown!)).not.toContain("animate-");
    expect(located.length).toBe(8);

    // Clicking still looks for the file; when it's missing, say so.
    await act(async () => { recording.reveal(); });
    await flush();
    expect(located.length).toBe(9);
    const titles = sonnerToast.getToasts().map((t) => ("title" in t ? t.title : undefined));
    expect(titles).toContain(`Couldn't find ${NAME}. Check your browser's downloads.`);
    expect(reveals("revealRecording")).toEqual([]);
  });

  test("a thumbnail that throws also falls back to the static icon", async () => {
    await mount({
      thumbnail: async () => { throw new Error("HEVC not supported"); },
      locate: async () => PATH,
      locateRetryMs: 1,
    });
    await act(async () => { recording.show({ fileName: NAME, blob: new Blob(["x"]) }); });
    await flush();
    expect(shownCard()).toMatchObject({ thumbFailed: true, path: PATH });
  });

  test("the spinner shows only while the thumbnail is still pending", () => {
    const pending = card({ id: "1", status: "saved", phase: "in", copy: RECORDING_TOAST_COPY });
    expect(pending).toContain("animate-");
    expect(pending).not.toContain("thumb-placeholder");
  });

  test("clicking reveals the located path in Finder", async () => {
    await mount({ thumbnail: async () => undefined, locate: async () => PATH, locateRetryMs: 1 });
    await act(async () => { recording.show({ fileName: NAME, blob: new Blob(["x"]) }); });
    await flush();
    expect(shownCard()?.path).toBe(PATH);

    await act(async () => { recording.reveal(); });
    expect(reveals("revealRecording")).toEqual([["revealRecording", { path: PATH }]]);
  });

  test("clicking before the path is known looks it up, patches the card, then reveals", async () => {
    let found = false;
    const located: string[] = [];
    await mount({
      thumbnail: async () => undefined,
      locate: async (fileName) => { located.push(fileName); return found ? PATH : ""; },
      locateRetryMs: 1,
    });
    await act(async () => { recording.show({ fileName: NAME, blob: new Blob(["x"]) }); });
    await flush(40);
    expect(shownCard()?.path).toBeUndefined();
    expect(reveals("revealRecording")).toEqual([]);

    found = true;
    await act(async () => { recording.reveal(); });
    await flush();
    expect(located.length).toBe(9);
    expect(shownCard()?.path).toBe(PATH);
    expect(reveals("revealRecording")).toEqual([["revealRecording", { path: PATH }]]);
    expect(reveals("revealScreenshot")).toEqual([]);
  });
});

describe("useScreenshotToast", () => {
  const SHOT = "/Users/x/Desktop/serve-sim-screenshot-1.png";

  test("clicking the screenshot card still calls revealScreenshot", async () => {
    hostReplies.screenshot = { path: SHOT };
    hostReplies.screenshotThumbnail = { data: "AAAA" };
    await mount(undefined, <ScreenshotHarness />);
    await act(async () => { await screenshot.capture(); });
    expect(shownCard()).toMatchObject({ status: "saved", path: SHOT, thumb: "data:image/png;base64,AAAA" });

    await act(async () => { screenshot.reveal(); });
    expect(reveals("revealScreenshot")).toEqual([["revealScreenshot", { path: SHOT }]]);
    expect(reveals("revealRecording")).toEqual([]);
  });

  test("a screenshot without a thumbnail shows the static icon", async () => {
    hostReplies.screenshot = { path: SHOT };
    await mount(undefined, <ScreenshotHarness />);
    await act(async () => { await screenshot.capture(); });
    const shown = shownCard();
    expect(shown).toMatchObject({ status: "saved", path: SHOT, thumbFailed: true });
    expect(card(shown!)).toContain('data-testid="thumb-placeholder"');
  });
});
