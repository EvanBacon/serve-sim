import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";
import { clearEventLogForTests, EVENT_LOG_MAX_ENTRIES, recordEventLogEvent, subscribeEventLog } from "../event-log";
import { ROLLING_BUFFER_ENV } from "../rolling-buffer";

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

/** Fake capture that counts every native call the buffer could make. */
function fakeCapture(overrides: Partial<DeviceSessionDependencies["capture"]> = {}) {
  const calls = { thumbnail: [] as Array<[number, number]>, contentChangeCount: 0, snapshotJpeg: 0, subscribeMjpeg: 0 };
  let content = 0;
  let fill = 1;
  const capture: DeviceSessionDependencies["capture"] = {
    start: async () => {},
    stop: async () => {},
    subscribeMjpeg: async () => { calls.subscribeMjpeg++; return () => {}; },
    subscribeAvcc: async () => () => {},
    subscribeSize: async () => () => {},
    snapshotJpeg: async () => { calls.snapshotJpeg++; return null; },
    setPreferredScreenSize: async () => {},
    contentChangeCount: () => { calls.contentChangeCount++; return content; },
    thumbnailJpeg: async (maxDimension: number, quality: number) => {
      calls.thumbnail.push([maxDimension, quality]);
      return { data: new Uint8Array([0xff, 0xd8, fill, 0xff, 0xd9]), width: 294, height: 640, sourceWidth: 1206, sourceHeight: 2622 };
    },
    ...overrides,
  };
  return { capture, calls, change: () => { content++; fill++; } };
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
    hardwareKeyboard: async () => false,
    pose: async () => false,
    hinge: async () => false,
  };
}

async function serve(session: DeviceSession): Promise<string> {
  sessions.push(session);
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/buffer") void session.handleBuffer(req, res, "status");
    else if (path === "/buffer/start") void session.handleBuffer(req, res, "start");
    else if (path === "/buffer/stop") void session.handleBuffer(req, res, "stop");
    else if (path === "/buffer/frame") void session.handleBuffer(req, res, "frame");
    else { res.writeHead(404); res.end(); }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("rolling buffer endpoints", () => {
  test("off by default: no buffer native calls while streams and status are used", async () => {
    const fake = fakeCapture();
    const session = new DeviceSession("DEV", { capture: fake.capture, hid: hid(), rollingBuffer: null });
    const base = await serve(session);
    await session.start();
    await wait(300);
    const status = await (await fetch(`${base}/buffer`)).json();
    expect(status).toEqual({ enabled: false });
    expect(fake.calls.thumbnail).toEqual([]);
    expect(fake.calls.contentChangeCount).toBe(0);
    expect(fake.calls.subscribeMjpeg).toBe(0);
    const frame = await fetch(`${base}/buffer/frame`);
    expect(frame.status).toBe(409);
    expect(await frame.json()).toMatchObject({ error: "buffer_off" });
  });

  test("with SERVE_SIM_BUFFER unset a default session never touches the buffer", async () => {
    const saved = process.env[ROLLING_BUFFER_ENV];
    delete process.env[ROLLING_BUFFER_ENV];
    try {
      const fake = fakeCapture();
      const session = new DeviceSession("DEV", { capture: fake.capture, hid: hid() });
      const base = await serve(session);
      await session.start();
      await wait(300);
      expect(await (await fetch(`${base}/buffer`)).json()).toEqual({ enabled: false });
      expect(fake.calls).toMatchObject({ thumbnail: [], contentChangeCount: 0, snapshotJpeg: 0, subscribeMjpeg: 0 });
    } finally {
      if (saved !== undefined) process.env[ROLLING_BUFFER_ENV] = saved;
    }
  });

  test("SERVE_SIM_BUFFER=on starts it with the session", async () => {
    const saved = process.env[ROLLING_BUFFER_ENV];
    process.env[ROLLING_BUFFER_ENV] = "on";
    try {
      const fake = fakeCapture();
      const session = new DeviceSession("DEV", { capture: fake.capture, hid: hid() });
      const base = await serve(session);
      await session.start();
      await wait(50);
      expect(await (await fetch(`${base}/buffer`)).json()).toMatchObject({ enabled: true, options: { seconds: 20, fps: 4 } });
      expect(fake.calls.thumbnail.length).toBe(1);
    } finally {
      if (saved === undefined) delete process.env[ROLLING_BUFFER_ENV];
      else process.env[ROLLING_BUFFER_ENV] = saved;
    }
  });

  test("start → frames with changed flags, repeats on a static screen; stop frees it", async () => {
    const fake = fakeCapture();
    const session = new DeviceSession("DEV", { capture: fake.capture, hid: hid(), rollingBuffer: null });
    const base = await serve(session);
    const start = await fetch(`${base}/buffer/start?fps=10&size=320&quality=0.5`, { method: "POST" });
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({ enabled: true, options: { fps: 10, maxDimension: 320, quality: 0.5, seconds: 20 } });
    await wait(350);
    fake.change();
    await wait(250);
    const view = await (await fetch(`${base}/buffer`)).json() as {
      enabled: boolean; samples: Array<{ frame: number; changed: boolean }>; frames: Array<{ id: number; bytes: number; width: number }>;
      stats: { frames: number; unchanged: number };
    };
    expect(view.enabled).toBe(true);
    expect(view.frames.length).toBe(2);
    expect(view.frames[0]).toMatchObject({ width: 294, bytes: 5 });
    expect(view.samples.filter((s) => s.changed).length).toBe(2);
    expect(view.stats.unchanged).toBeGreaterThan(0);
    expect(fake.calls.thumbnail.length).toBe(2);
    expect(fake.calls.thumbnail[0]).toEqual([320, 0.5]);

    const latest = await fetch(`${base}/buffer/frame`);
    expect(latest.status).toBe(200);
    expect(latest.headers.get("content-type")).toBe("image/jpeg");
    expect([...new Uint8Array(await latest.arrayBuffer())]).toEqual([0xff, 0xd8, 2, 0xff, 0xd9]);
    const meta = JSON.parse(latest.headers.get("x-serve-sim-buffer-frame")!);
    expect(meta).toMatchObject({ id: view.frames[1]!.id, width: 294, height: 640 });

    const first = await fetch(`${base}/buffer/frame?id=${view.frames[0]!.id}`);
    expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([0xff, 0xd8, 1, 0xff, 0xd9]);

    const stop = await fetch(`${base}/buffer/stop`, { method: "POST" });
    expect(await stop.json()).toEqual({ enabled: false, stopped: true });
    const calls = fake.calls.contentChangeCount;
    await wait(250);
    expect(fake.calls.contentChangeCount).toBe(calls);
    expect(await (await fetch(`${base}/buffer`)).json()).toEqual({ enabled: false });
  });

  test("frame by age, unknown ids, and bad params", async () => {
    const fake = fakeCapture();
    // A server-wide default (`serve-sim --buffer`) starts it with the session.
    const session = new DeviceSession("DEV", { capture: fake.capture, hid: hid(), rollingBuffer: { seconds: 20, fps: 10, maxDimension: 640, quality: 0.6, maxBytes: 24 << 20 } });
    const base = await serve(session);
    await session.start();
    await wait(150);
    expect((await fetch(`${base}/buffer/frame?ago=0`)).status).toBe(200);
    expect((await fetch(`${base}/buffer/frame?ago=60`)).status).toBe(404);
    expect(await (await fetch(`${base}/buffer/frame?id=999`)).json()).toMatchObject({ error: "frame_not_found" });
    for (const q of ["id=abc", "ago=-1", "id=1&ago=1"]) {
      const res = await fetch(`${base}/buffer/frame?${q}`);
      expect(res.status).toBe(400);
    }
    const bad = await fetch(`${base}/buffer?since=x`);
    expect(bad.status).toBe(400);
  });

  test("start validates options; a second start with other options is a 409, the same options are idempotent", async () => {
    const fake = fakeCapture();
    const base = await serve(new DeviceSession("DEV", { capture: fake.capture, hid: hid(), rollingBuffer: null }));
    const bad = await fetch(`${base}/buffer/start?seconds=600`, { method: "POST" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_buffer_options" });
    expect((await fetch(`${base}/buffer/start?fps=10`, { method: "POST" })).status).toBe(200);
    const again = await fetch(`${base}/buffer/start?fps=10`, { method: "POST" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ enabled: true, alreadyRunning: true });
    const other = await fetch(`${base}/buffer/start?fps=5`, { method: "POST" });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: "buffer_running", options: { fps: 10 } });
  });

  test("a start racing the session's own start never returns other options", async () => {
    // Gate capture.start so the request's check-then-await window is open.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeCapture({ start: () => gate });
    // The session's default (`serve-sim --buffer`) is 20 s.
    const session = new DeviceSession("DEV", { capture: fake.capture, hid: hid(), rollingBuffer: { seconds: 20, fps: 4, maxDimension: 640, quality: 0.6, maxBytes: 24 << 20 } });
    const base = await serve(session);
    void session.start().catch(() => {});
    const pending = fetch(`${base}/buffer/start?seconds=10`, { method: "POST" });
    const same = fetch(`${base}/buffer/start?seconds=20`, { method: "POST" });
    await wait(50);
    release();
    const res = await pending;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "buffer_running", options: { seconds: 20 } });
    const sameRes = await same;
    expect(sameRes.status).toBe(200);
    expect(await sameRes.json()).toMatchObject({ enabled: true, alreadyRunning: true, options: { seconds: 20 } });
  });

  test("two concurrent starts with different options: one wins, the other is a 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeCapture({ start: () => gate });
    const base = await serve(new DeviceSession("DEV", { capture: fake.capture, hid: hid(), rollingBuffer: null }));
    const a = fetch(`${base}/buffer/start?seconds=10`, { method: "POST" });
    const b = fetch(`${base}/buffer/start?seconds=30`, { method: "POST" });
    await wait(50);
    release();
    const results = await Promise.all([a, b].map(async (p, i) => {
      const res = await p;
      return { asked: i === 0 ? 10 : 30, status: res.status, body: await res.json() as { options: { seconds: number } } };
    }));
    const ok = results.filter((r) => r.status === 200);
    const conflict = results.filter((r) => r.status === 409);
    expect(ok.length).toBe(1);
    expect(conflict.length).toBe(1);
    expect(ok[0]!.body.options.seconds).toBe(ok[0]!.asked);
    expect(conflict[0]!.body).toMatchObject({ error: "buffer_running", options: { seconds: ok[0]!.asked } });
  });

  test("method checks", async () => {
    const base = await serve(new DeviceSession("DEV", { capture: fakeCapture().capture, hid: hid(), rollingBuffer: null }));
    expect((await fetch(`${base}/buffer/start`)).status).toBe(405);
    expect((await fetch(`${base}/buffer/stop`)).status).toBe(405);
    expect((await fetch(`${base}/buffer`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/buffer/stop`, { method: "POST" })).status).toBe(200); // stopping when off is fine
  });

  test("an addon without thumbnails reports buffer_unsupported", async () => {
    const fake = fakeCapture({ thumbnailJpeg: undefined });
    const base = await serve(new DeviceSession("DEV", { capture: fake.capture, hid: hid(), rollingBuffer: null }));
    const res = await fetch(`${base}/buffer/start`, { method: "POST" });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: "buffer_unsupported" });
  });

  test("this device's HID events are joined to frames", async () => {
    const fake = fakeCapture();
    const base = await serve(new DeviceSession("DEV", {
      capture: fake.capture, hid: hid(), rollingBuffer: null, subscribeEventLog,
    }));
    await fetch(`${base}/buffer/start?fps=10`, { method: "POST" });
    await wait(150);
    recordEventLogEvent({ source: "hid", kind: "tap", summary: "Tap (0.50, 0.90)", device: "DEV", status: "ok", details: { x: 0.5, y: 0.9 } });
    recordEventLogEvent({ source: "hid", kind: "tap", summary: "Tap elsewhere", device: "OTHER", status: "ok" });
    fake.change();
    await wait(200);
    const view = await (await fetch(`${base}/buffer`)).json() as { events: Array<{ kind: string; frame: number; nextChange?: { frame: number } }>; frames: Array<{ id: number }> };
    expect(view.events.length).toBe(1);
    expect(view.events[0]).toMatchObject({ kind: "tap", frame: view.frames[0]!.id, nextChange: { frame: view.frames[1]!.id } });
    const noEvents = await (await fetch(`${base}/buffer?events=0`)).json() as { events?: unknown };
    expect(noEvents.events).toBeUndefined();
    const statsOnly = await (await fetch(`${base}/buffer?stats=1`)).json() as Record<string, unknown>;
    expect(Object.keys(statsOnly).sort()).toEqual(["enabled", "options", "startedAt", "stats"]);
    expect(statsOnly.stats).toMatchObject({ frames: 2, events: 1 });
  });

  test("silent mid-drag updates and an evicted drag's end reach the buffer", async () => {
    const fake = fakeCapture();
    const session = new DeviceSession("DEV", { capture: fake.capture, hid: hid(), rollingBuffer: null, subscribeEventLog });
    const base = await serve(session);
    let receive!: (data: Buffer) => void;
    session.attachHidSocket({ send() {}, close() {}, on(event, cb) { if (event === "message") receive = cb as (data: Buffer) => void; } });
    const touch = (type: string, x: number, y: number) =>
      receive(Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify({ type, x, y }))]));
    type View = { events: Array<{ kind: string; x?: number; y?: number; t: number; tEnd?: number }> };
    const drag = async () => ((await (await fetch(`${base}/buffer`)).json()) as View).events.find((e) => e.kind === "drag")!;

    await fetch(`${base}/buffer/start?fps=10`, { method: "POST" });
    await wait(150);
    touch("begin", 0.1, 0.1);
    touch("move", 0.3, 0.3); // first move: logged (and notified)
    await wait(60);
    touch("move", 0.6, 0.7); // silent update
    const moving = await drag();
    expect(moving).toMatchObject({ x: 0.6, y: 0.7 });
    expect(moving.tEnd!).toBeGreaterThan(moving.t);

    // Busy input on another device pushes the drag out of the global ring.
    for (let i = 0; i < EVENT_LOG_MAX_ENTRIES + 10; i++) {
      recordEventLogEvent({ device: "OTHER", source: "hid", kind: "tap", summary: `Other ${i}` });
    }
    await wait(60);
    touch("move", 0.65, 0.75); // silent update, no longer in the global log
    expect(await drag()).toMatchObject({ x: 0.65, y: 0.75 });
    touch("end", 0.8, 0.9); // notified update, also evicted
    const ended = await drag();
    expect(ended).toMatchObject({ x: 0.8, y: 0.9 });
    expect(ended.tEnd!).toBeGreaterThan(moving.tEnd!);
  });

  test("closing the session stops the buffer", async () => {
    const fake = fakeCapture();
    const session = new DeviceSession("DEV", { capture: fake.capture, hid: hid(), rollingBuffer: null });
    const base = await serve(session);
    await fetch(`${base}/buffer/start?fps=10`, { method: "POST" });
    await wait(150);
    session.close();
    const calls = fake.calls.contentChangeCount;
    await wait(250);
    expect(fake.calls.contentChangeCount).toBe(calls);
  });
});
