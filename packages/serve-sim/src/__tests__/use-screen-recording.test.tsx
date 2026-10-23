import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useScreenRecording } from "../client/hooks/use-screen-recording";

type Call = { method: string; path: string };
type Handler = (call: Call) => Response | Promise<Response>;

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;
let dom: Window;
let root: Root | undefined;
let previous: Map<string, unknown>;
let realFetch: typeof fetch;
let calls: Call[];
let handler: Handler;
let hook: ReturnType<typeof useScreenRecording>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
  handler = () => json({ recording: false });
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

function Harness({ device, pollMs }: { device: string | null; pollMs: number }) {
  hook = useScreenRecording(device, { pollMs });
  return null;
}

async function render(device: string | null, pollMs = 60_000) {
  await act(async () => {
    if (!root) root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    root.render(<Harness device={device} pollMs={pollMs} />);
  });
  await flush();
}

async function flush(ms = 5) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

const STARTED = "2026-10-23T08:00:00.000Z";

describe("useScreenRecording", () => {
  test("a failed stop re-reads server status instead of forcing idle", async () => {
    handler = ({ method, path }) => {
      if (path.endsWith("/recording/stop")) return json({ error: "recording_failed", message: "boom" }, 500);
      if (method === "GET") return json({ recording: true, startedAt: STARTED });
      return json({});
    };
    await render("A");
    expect(hook.state).toEqual({ status: "recording", startedAt: Date.parse(STARTED) });

    await act(async () => { await hook.stop(); });
    expect(calls.some((c) => c.method === "POST" && c.path === "/helper/A/recording/stop")).toBe(true);
    expect(hook.state).toEqual({ status: "recording", startedAt: Date.parse(STARTED) });
  });

  test("a failed stop goes idle when the server says the recording is gone", async () => {
    let recording = true;
    handler = ({ method, path }) => {
      if (path.endsWith("/recording/stop")) { recording = false; return json({ error: "not_recording" }, 409); }
      if (method === "GET") return json(recording ? { recording: true, startedAt: STARTED } : { recording: false });
      return json({});
    };
    await render("A");
    await act(async () => { await hook.stop(); });
    expect(hook.state).toEqual({ status: "idle" });
  });

  test("a start that resolves after a device switch stops that device's recording", async () => {
    let releaseStart!: () => void;
    handler = ({ path }) => {
      if (path === "/helper/A/recording/start") {
        return new Promise<Response>((resolve) => {
          releaseStart = () => resolve(json({ recording: true, startedAt: STARTED }));
        });
      }
      if (path === "/helper/A/recording/stop") return new Response("mp4", { headers: { "content-type": "video/mp4" } });
      return json({ recording: false });
    };
    await render("A");
    let started!: Promise<void>;
    await act(async () => { started = hook.start(); });
    expect(hook.state.status).toBe("starting");

    await render("B");
    await act(async () => { releaseStart(); await started; });
    await flush();
    expect(calls.some((c) => c.method === "POST" && c.path === "/helper/A/recording/stop")).toBe(true);
    expect(hook.state).toEqual({ status: "idle" });
  });

  test("a start that resolves after unmount stops the recording", async () => {
    let releaseStart!: () => void;
    handler = ({ path }) => {
      if (path === "/helper/A/recording/start") {
        return new Promise<Response>((resolve) => {
          releaseStart = () => resolve(json({ recording: true, startedAt: STARTED }));
        });
      }
      return json({ recording: false });
    };
    await render("A");
    let started!: Promise<void>;
    await act(async () => { started = hook.start(); });
    await act(async () => { root!.unmount(); });
    root = undefined;
    releaseStart();
    await started;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls.some((c) => c.method === "POST" && c.path === "/helper/A/recording/stop")).toBe(true);
  });

  test("polls the server so recordings started or stopped elsewhere show up", async () => {
    let status: unknown = { recording: false };
    handler = () => json(status);
    await render("A", 10);
    expect(hook.state).toEqual({ status: "idle" });

    status = { recording: true, startedAt: STARTED };
    await flush(40);
    expect(hook.state).toEqual({ status: "recording", startedAt: Date.parse(STARTED) });

    status = { recording: false };
    await flush(40);
    expect(hook.state).toEqual({ status: "idle" });
  });

  test("collects its own recording when the server reports the duration cap", async () => {
    let limitReached = false;
    let started = false;
    let stopPath: string | undefined;
    handler = ({ method, path }) => {
      if (path.endsWith("/recording/start")) { started = true; return json({ recording: true, startedAt: STARTED, token: "tok-1" }); }
      if (path.includes("/recording/stop")) {
        stopPath = path;
        return new Response("mp4", {
          headers: { "content-type": "video/mp4", "content-disposition": 'attachment; filename="x.mp4"' },
        });
      }
      if (method === "GET") {
        if (!started || stopPath) return json({ recording: false });
        return json({ recording: true, startedAt: STARTED, ...(limitReached ? { limitReached } : {}) });
      }
      return json({});
    };
    await render("A", 10);
    await act(async () => { await hook.start(); });
    expect(hook.state.status).toBe("recording");
    limitReached = true;
    await flush(60);
    expect(stopPath).toBe("/helper/A/recording/stop?token=tok-1");
    expect(hook.state).toEqual({ status: "idle" });
  });

  test("leaves a capped recording it didn't start to its owner", async () => {
    handler = ({ method }) => method === "GET"
      ? json({ recording: true, startedAt: STARTED, limitReached: true })
      : json({});
    await render("A", 10);
    await flush(60);
    expect(calls.some((c) => c.path.includes("/recording/stop"))).toBe(false);
    expect(hook.state.status).toBe("recording");
  });

  test("drops a status response that is older than a newer poll", async () => {
    let releaseSlow!: () => void;
    let polls = 0;
    handler = ({ method }) => {
      if (method !== "GET") return json({});
      polls++;
      // Poll 2 hangs and answers "recording" only after poll 3 said idle.
      if (polls === 2) {
        return new Promise<Response>((resolve) => {
          releaseSlow = () => resolve(json({ recording: true, startedAt: STARTED }));
        });
      }
      return json({ recording: false });
    };
    await render("A", 10);
    for (let i = 0; i < 20 && polls < 3; i++) await flush(10);
    expect(polls).toBeGreaterThanOrEqual(3);
    releaseSlow();
    await flush(5);
    expect(hook.state).toEqual({ status: "idle" });
  });
});
