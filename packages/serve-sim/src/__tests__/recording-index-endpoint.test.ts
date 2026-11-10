import { afterEach, describe, expect, test } from "bun:test";
import { createServer, request, type IncomingMessage, type Server } from "http";
import { writeFileSync } from "fs";
import type { AddressInfo } from "net";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";
import { clearEventLogForTests, EVENT_LOG_MAX_ENTRIES, recordEventLogEvent, subscribeEventLog } from "../event-log";
import type { RecordingStartOptions } from "../native";
import type { NativeRecordingIndex } from "../recording-index";

const servers: Server[] = [];
const sessions: DeviceSession[] = [];

afterEach(async () => {
  clearEventLogForTests();
  for (const session of sessions.splice(0)) session.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

const LEGACY_SUMMARY = { width: 1206, height: 2622, fps: 60, codec: "h264", rotation: 0, frames: 600, duration: 10 };

/**
 * Fake native recorder: armed at uptime 500 s == the wall time of start. Like
 * the addon, it adds `index` to the summary only when the start asked for it
 * (`nativeIndex: false` models an addon without frame metadata). `starts`
 * records the options each start passed; `mp4Bytes` sizes the fake MP4.
 */
function fakeCapture(
  { nativeIndex = true, starts = [], startRecording, mp4Bytes }: {
    nativeIndex?: boolean;
    starts?: RecordingStartOptions[];
    startRecording?: () => Promise<void>;
    mp4Bytes?: number;
  } = {},
): DeviceSessionDependencies["capture"] {
  let active: { path: string; armedWallMs: number; index: boolean } | undefined;
  return {
    start: async () => {},
    stop: async () => {},
    subscribeMjpeg: async () => () => {},
    subscribeAvcc: async () => () => {},
    subscribeSize: async () => () => {},
    snapshotJpeg: async () => null,
    setPreferredScreenSize: async () => {},
    startRecording: async (path, options) => {
      starts.push(options);
      await startRecording?.();
      active = { path, armedWallMs: Date.now(), index: options.index === true };
    },
    stopRecording: async () => {
      const { path, armedWallMs, index: wantIndex } = active!;
      active = undefined;
      writeFileSync(path, mp4Bytes != null ? Buffer.alloc(mp4Bytes) : Buffer.from("fake-mp4"));
      const index: NativeRecordingIndex = {
        version: 1,
        fps: 60,
        clock: { armedUptime: 500, armedWallMs, originUptime: 500 },
        slots: [0, 1, 2],
        uptimesUs: [500_000_000, 500_000_000, 500_033_333],
        changed: [1, 0, 1],
        changedCount: 2,
        truncated: false,
      };
      return JSON.stringify({ path, ...LEGACY_SUMMARY, ...(nativeIndex && wantIndex ? { index } : {}) });
    },
  };
}

function hid(): DeviceSessionDependencies["hid"] {
  return {
    touch: async () => {},
    multiTouch: async () => {},
    button: async () => {},
    buttonHid: async () => {},
    key: async () => {},
    scroll: async () => {},
    digitalCrown: async () => {},
    orientation: async () => false,
    memoryWarning: async () => {},
    softwareKeyboard: async () => {},
    caDebug: async () => false,
    pose: async () => false,
    hinge: async () => false,
  };
}

async function serve(session: DeviceSession): Promise<string> {
  sessions.push(session);
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/recording") void session.handleRecording(req, res, "status");
    else if (path === "/recording/start") void session.handleRecording(req, res, "start");
    else if (path === "/recording/stop") void session.handleRecording(req, res, "stop");
    else if (path === "/recording/index") void session.handleRecording(req, res, "index");
    else { res.writeHead(404); res.end(); }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Event-log subscription that counts live subscribers (for leak checks). */
function countingSubscribe() {
  const counter = { live: 0, subscribe: (subscriber: Parameters<typeof subscribeEventLog>[0]) => {
    const unsubscribe = subscribeEventLog(subscriber);
    counter.live++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      counter.live--;
      unsubscribe();
    };
  } };
  return counter;
}

async function recordOnce(
  base: string,
  during?: () => void | Promise<void>,
  { index = true }: { index?: boolean } = {},
): Promise<{ token: string; stop: Response }> {
  const start = `${base}/recording/start${index ? "?index=1" : ""}`;
  const { token } = await (await fetch(start, { method: "POST" })).json() as { token: string };
  await during?.();
  const stop = await fetch(`${base}/recording/stop?token=${token}`, { method: "POST" });
  return { token, stop };
}

const parseLines = (text: string) => text.trimEnd().split("\n").map((line) => JSON.parse(line));

describe("GET /recording/index", () => {
  test("the stop response is the same with and without index=1", async () => {
    const results: Array<{ headers: Record<string, string | null>; body: string }> = [];
    for (const index of [false, true]) {
      const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid() }));
      const { stop } = await recordOnce(base, undefined, { index });
      results.push({
        headers: {
          type: stop.headers.get("content-type"),
          length: stop.headers.get("content-length"),
          summary: stop.headers.get("x-serve-sim-recording"),
        },
        body: await stop.text(),
      });
    }
    expect(results[1]).toEqual(results[0]!);
    expect(results[1]!.headers.summary).toBe(JSON.stringify(LEGACY_SUMMARY));
  });

  test("serves the JSONL index for the start token, with the recording's HID events", async () => {
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid() }));
    const before = recordEventLogEvent({ device: "TEST-UDID", source: "hid", kind: "tap", summary: "Tap early", timestamp: new Date(Date.now() - 5_000).toISOString() });
    const { token, stop } = await recordOnce(base, () => {
      recordEventLogEvent({ device: "TEST-UDID", source: "hid", kind: "tap", action: "tap", summary: "Tap (0.5, 0.25)", details: { current: { x: 0.5, y: 0.25 } } });
      recordEventLogEvent({ device: "OTHER", source: "hid", kind: "tap", summary: "Tap other" });
      recordEventLogEvent({ device: "TEST-UDID", source: "exec", kind: "command", summary: "simctl" });
    });
    await stop.arrayBuffer();
    const disposition = stop.headers.get("content-disposition")!;
    const mp4Name = /filename="([^"]+)"/.exec(disposition)![1]!;

    const res = await fetch(`${base}/recording/index?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${mp4Name.replace(/\.mp4$/, ".index.jsonl")}"`);
    const lines = parseLines(await res.text());
    expect(lines[0]).toMatchObject({ type: "header", file: mp4Name, fps: 60, width: 1206, height: 2622, codec: "h264" });
    expect(lines.filter((l) => l.type === "frame").map((l) => l.changed)).toEqual([true, false, true]);
    const events = lines.filter((l) => l.type === "event");
    expect(events.map((e) => e.summary)).toEqual(["Tap (0.5, 0.25)"]);
    expect(events[0]).toMatchObject({ kind: "tap", x: 0.5, y: 0.25 });
    expect(events[0].t).toBeGreaterThanOrEqual(0);
    expect(events[0].t).toBeLessThan(5);
    expect(lines.at(-1)).toEqual({ type: "footer", frames: 3, changedFrames: 2, durationSec: 10, events: 1, eventsDropped: 0, truncated: false });
    expect(before.id).toBeGreaterThan(0);

    // Still there for a second reader (e.g. the toolbar and the CLI).
    expect((await fetch(`${base}/recording/index?token=${token}`)).status).toBe(200);
  });

  test("file= names the MP4 in the header and the download", async () => {
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid() }));
    const { token, stop } = await recordOnce(base);
    await stop.arrayBuffer();
    const res = await fetch(`${base}/recording/index?token=${token}&file=${encodeURIComponent("my clip.mp4")}`);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="my clip.index.jsonl"`);
    expect(parseLines(await res.text())[0].file).toBe("my clip.mp4");
  });

  test("requires a known token and GET", async () => {
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid() }));
    const { token, stop } = await recordOnce(base);
    await stop.arrayBuffer();
    const missing = await fetch(`${base}/recording/index`);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "missing_token" });
    const unknown = await fetch(`${base}/recording/index?token=nope`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "index_not_found" });
    expect((await fetch(`${base}/recording/index?token=${token}`, { method: "POST" })).status).toBe(405);
  });

  test("an addon without frame metadata has no index", async () => {
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture({ nativeIndex: false }), hid: hid() }));
    const { token, stop } = await recordOnce(base);
    await stop.arrayBuffer();
    const res = await fetch(`${base}/recording/index?token=${token}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "index_not_found" });
  });

  test("keeps only the most recent indexes", async () => {
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid() }));
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { token, stop } = await recordOnce(base);
      await stop.arrayBuffer();
      tokens.push(token);
    }
    expect((await fetch(`${base}/recording/index?token=${tokens[0]}`)).status).toBe(404);
    expect((await fetch(`${base}/recording/index?token=${tokens[4]}`)).status).toBe(200);
  });

  test("without index=1 nothing is collected natively or in JS, and there is no index", async () => {
    const starts: RecordingStartOptions[] = [];
    const counter = countingSubscribe();
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture({ starts }), hid: hid(), subscribeEventLog: counter.subscribe }));
    const { token, stop } = await recordOnce(base, () => {
      expect(counter.live).toBe(0);
      recordEventLogEvent({ device: "TEST-UDID", source: "hid", kind: "tap", summary: "Tap" });
    }, { index: false });
    expect(stop.headers.get("x-serve-sim-recording")).toBe(JSON.stringify(LEGACY_SUMMARY));
    await stop.arrayBuffer();
    expect(starts).toEqual([{ codec: "h264", fps: 60, rotation: 0 }]);
    expect((await fetch(`${base}/recording/index?token=${token}`)).status).toBe(404);
  });

  test("index=1 is passed to the native recorder", async () => {
    const starts: RecordingStartOptions[] = [];
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture({ starts }), hid: hid() }));
    await (await recordOnce(base)).stop.arrayBuffer();
    expect(starts).toEqual([{ codec: "h264", fps: 60, index: true, rotation: 0 }]);
  });

  test("HEAD returns the headers without a body", async () => {
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid() }));
    const { token, stop } = await recordOnce(base);
    await stop.arrayBuffer();
    const res = await fetch(`${base}/recording/index?token=${token}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/\.index\.jsonl"$/);
    expect(await res.text()).toBe("");
  });

  test("an index expires after its TTL", async () => {
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid(), recordingIndexTtlMs: 300 }));
    const { token, stop } = await recordOnce(base);
    await stop.arrayBuffer();
    expect((await fetch(`${base}/recording/index?token=${token}`)).status).toBe(200);
    await Bun.sleep(500);
    expect((await fetch(`${base}/recording/index?token=${token}`)).status).toBe(404);
  });

  test("the TTL starts once the MP4 has been sent, not at stop", async () => {
    // Big enough that a paused reader stalls the transfer on socket buffers.
    const base = await serve(new DeviceSession("TEST-UDID", {
      capture: fakeCapture({ mp4Bytes: 64 * 1024 * 1024 }), hid: hid(), recordingIndexTtlMs: 300,
    }));
    const { token } = await (await fetch(`${base}/recording/start?index=1`, { method: "POST" })).json() as { token: string };
    const stop = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(`${base}/recording/stop?token=${token}`, { method: "POST" }, resolve);
      req.once("error", reject);
      req.end();
    });
    stop.pause();
    expect(stop.statusCode).toBe(200);
    await Bun.sleep(500); // past the TTL, download still in flight
    expect((await fetch(`${base}/recording/index?token=${token}`)).status).toBe(200);
    await new Promise<void>((resolve) => { stop.on("end", resolve); stop.resume(); });
    expect((await fetch(`${base}/recording/index?token=${token}`)).status).toBe(200);
    await Bun.sleep(500);
    expect((await fetch(`${base}/recording/index?token=${token}`)).status).toBe(404);
  });

  test("close() drops kept indexes", async () => {
    const session = new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid() });
    const base = await serve(session);
    const { token, stop } = await recordOnce(base);
    await stop.arrayBuffer();
    session.close();
    expect((await fetch(`${base}/recording/index?token=${token}`)).status).toBe(404);
  });

  test("events logged after the duration cap are left out", async () => {
    const counter = countingSubscribe();
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid(), maxRecordingMs: 30, subscribeEventLog: counter.subscribe }));
    const { token, stop } = await recordOnce(base, async () => {
      recordEventLogEvent({ device: "TEST-UDID", source: "hid", kind: "tap", summary: "Before cap" });
      await waitFor(async () => ((await (await fetch(`${base}/recording`)).json()) as { limitReached?: boolean }).limitReached === true);
      expect(counter.live).toBe(0);
      recordEventLogEvent({ device: "TEST-UDID", source: "hid", kind: "tap", summary: "After cap" });
    });
    expect(stop.status).toBe(200);
    await stop.arrayBuffer();
    const lines = parseLines(await (await fetch(`${base}/recording/index?token=${token}`)).text());
    expect(lines.filter((l) => l.type === "event").map((l) => l.summary)).toEqual(["Before cap"]);
  });

  test("a drag still in progress at stop keeps its latest point", async () => {
    const session = new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid() });
    const base = await serve(session);
    let receive!: (data: Buffer) => void;
    session.attachHidSocket({ send() {}, close() {}, on(event, cb) { if (event === "message") receive = cb as (data: Buffer) => void; } });
    const touch = (type: string, x: number, y: number) =>
      receive(Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify({ type, x, y }))]));
    const { token, stop } = await recordOnce(base, async () => {
      touch("begin", 0.1, 0.1);
      touch("move", 0.3, 0.3); // first move: logged (and notified)
      await Bun.sleep(20);
      touch("move", 0.6, 0.7); // silent update
    });
    await stop.arrayBuffer();
    const lines = parseLines(await (await fetch(`${base}/recording/index?token=${token}`)).text());
    const [drag] = lines.filter((l) => l.type === "event");
    expect(drag).toMatchObject({ kind: "drag", x: 0.6, y: 0.7, start: { x: 0.1, y: 0.1 } });
    expect(drag.tEnd).toBeGreaterThan(drag.t);
  });

  test("a long drag evicted from the global event log still gets its later points", async () => {
    const session = new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid() });
    const base = await serve(session);
    let receive!: (data: Buffer) => void;
    session.attachHidSocket({ send() {}, close() {}, on(event, cb) { if (event === "message") receive = cb as (data: Buffer) => void; } });
    const touch = (type: string, x: number, y: number) =>
      receive(Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify({ type, x, y }))]));
    const flood = () => {
      // Busy input on another device pushes the drag out of the 500-entry ring.
      for (let i = 0; i < EVENT_LOG_MAX_ENTRIES + 10; i++) {
        recordEventLogEvent({ device: "OTHER-UDID", source: "hid", kind: "tap", summary: `Other ${i}` });
      }
    };
    const run = async (end: boolean) => {
      const { token, stop } = await recordOnce(base, async () => {
        touch("begin", 0.1, 0.1);
        touch("move", 0.3, 0.3); // first move: logged (and notified)
        flood();
        await Bun.sleep(20);
        touch("move", 0.6, 0.7); // silent update, no longer in the global log
        if (end) {
          flood();
          touch("end", 0.8, 0.9); // notified update, also evicted
        }
      });
      await stop.arrayBuffer();
      const lines = parseLines(await (await fetch(`${base}/recording/index?token=${token}`)).text());
      return lines.filter((l) => l.type === "event");
    };
    const [moving] = await run(false);
    expect(moving).toMatchObject({ kind: "drag", x: 0.6, y: 0.7, start: { x: 0.1, y: 0.1 } });
    expect(moving.tEnd).toBeGreaterThan(moving.t);
    const [ended] = await run(true);
    expect(ended).toMatchObject({ kind: "drag", x: 0.8, y: 0.9, start: { x: 0.1, y: 0.1 } });
  });
});

describe("event-log subscription lifecycle", () => {
  test("unsubscribes after a normal stop", async () => {
    const counter = countingSubscribe();
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid(), subscribeEventLog: counter.subscribe }));
    const { stop } = await recordOnce(base, () => { expect(counter.live).toBe(1); });
    await stop.arrayBuffer();
    expect(counter.live).toBe(0);
  });

  test("unsubscribes when the native start throws", async () => {
    const counter = countingSubscribe();
    const capture = fakeCapture({ startRecording: async () => { throw new Error("boom"); } });
    const session = new DeviceSession("TEST-UDID", { capture, hid: hid(), subscribeEventLog: counter.subscribe });
    const base = await serve(session);
    const res = await fetch(`${base}/recording/start?index=1`, { method: "POST" });
    await res.arrayBuffer();
    expect(res.ok).toBe(false);
    expect(counter.live).toBe(0);
  });

  test("unsubscribes when the session closes during the start", async () => {
    const counter = countingSubscribe();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const session = new DeviceSession("TEST-UDID", { capture: fakeCapture({ startRecording: () => gate }), hid: hid(), subscribeEventLog: counter.subscribe });
    const base = await serve(session);
    const pending = fetch(`${base}/recording/start?index=1`, { method: "POST" });
    await waitFor(() => counter.live === 1);
    session.close();
    release();
    const res = await pending;
    expect(res.status).toBe(409);
    expect(counter.live).toBe(0);
  });

  test("unsubscribes when the session closes while recording", async () => {
    const counter = countingSubscribe();
    const session = new DeviceSession("TEST-UDID", { capture: fakeCapture(), hid: hid(), subscribeEventLog: counter.subscribe });
    const base = await serve(session);
    await (await fetch(`${base}/recording/start?index=1`, { method: "POST" })).arrayBuffer();
    expect(counter.live).toBe(1);
    session.close();
    expect(counter.live).toBe(0);
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(5);
  }
}
