import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "http";
import { writeFileSync } from "fs";
import type { AddressInfo } from "net";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";
import { clearEventLogForTests, recordEventLogEvent } from "../event-log";
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

/** Fake native recorder: armed at uptime 500 s == the wall time of start. */
function fakeCapture(withIndex = true): DeviceSessionDependencies["capture"] {
  let active: { path: string; armedWallMs: number } | undefined;
  return {
    start: async () => {},
    stop: async () => {},
    subscribeMjpeg: async () => () => {},
    subscribeAvcc: async () => () => {},
    subscribeSize: async () => () => {},
    snapshotJpeg: async () => null,
    setPreferredScreenSize: async () => {},
    startRecording: async (path) => {
      active = { path, armedWallMs: Date.now() };
    },
    stopRecording: async () => {
      const { path, armedWallMs } = active!;
      active = undefined;
      writeFileSync(path, Buffer.from("fake-mp4"));
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
      return JSON.stringify({ path, ...LEGACY_SUMMARY, ...(withIndex ? { index } : {}) });
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

async function recordOnce(base: string, during?: () => void): Promise<{ token: string; stop: Response }> {
  const { token } = await (await fetch(`${base}/recording/start`, { method: "POST" })).json() as { token: string };
  during?.();
  const stop = await fetch(`${base}/recording/stop?token=${token}`, { method: "POST" });
  return { token, stop };
}

const parseLines = (text: string) => text.trimEnd().split("\n").map((line) => JSON.parse(line));

describe("GET /recording/index", () => {
  test("the stop response is unchanged by the native index", async () => {
    const results: Array<{ headers: Record<string, string | null>; body: string }> = [];
    for (const withIndex of [false, true]) {
      const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(withIndex), hid: hid() }));
      const { stop } = await recordOnce(base);
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
    expect(lines.at(-1)).toEqual({ type: "footer", frames: 3, changedFrames: 2, durationSec: 10, events: 1, truncated: false });
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
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(false), hid: hid() }));
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
});
