import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "http";
import { existsSync, writeFileSync } from "fs";
import type { AddressInfo } from "net";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";
import type { RecordingStartOptions } from "../native";

const servers: Server[] = [];
const sessions: DeviceSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

type RecordingCalls = { starts: Array<{ path: string; options: RecordingStartOptions }>; stops: number };

function fakeCapture(
  calls: RecordingCalls,
  overrides: Partial<DeviceSessionDependencies["capture"]> = {},
  onSize?: (cb: (size: { width: number; height: number }) => void) => void,
): DeviceSessionDependencies["capture"] {
  let active: string | undefined;
  return {
    start: async () => {},
    stop: async () => {},
    subscribeMjpeg: async () => () => {},
    subscribeAvcc: async () => () => {},
    subscribeSize: async (cb) => { onSize?.(cb); return () => {}; },
    snapshotJpeg: async () => null,
    setPreferredScreenSize: async () => {},
    startRecording: async (path, options) => {
      calls.starts.push({ path, options });
      active = path;
    },
    stopRecording: async () => {
      calls.stops++;
      const path = active!;
      active = undefined;
      writeFileSync(path, Buffer.from("fake-mp4"));
      return JSON.stringify({ path, width: 1206, height: 2622, fps: 60, frames: 600, duration: 10 });
    },
    ...overrides,
  };
}

function hid(orientation = false): DeviceSessionDependencies["hid"] {
  return {
    touch: async () => {},
    multiTouch: async () => {},
    button: async () => {},
    buttonHid: async () => {},
    key: async () => {},
    scroll: async () => {},
    digitalCrown: async () => {},
    orientation: async () => orientation,
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
    else { res.writeHead(404); res.end(); }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("DeviceSession recording endpoints", () => {
  test("start records full-rate H.264 by default and reports status", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(calls), hid: hid() }));

    expect(await (await fetch(`${base}/recording`)).json()).toEqual({ recording: false });

    const res = await fetch(`${base}/recording/start`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { recording: boolean; startedAt: string };
    expect(body.recording).toBe(true);
    expect(typeof body.startedAt).toBe("string");
    expect(calls.starts).toHaveLength(1);
    expect(calls.starts[0]!.path).toMatch(/\.mp4$/);
    expect(calls.starts[0]!.options).toEqual({ codec: "h264", fps: 60, rotation: 0 });

    const status = await (await fetch(`${base}/recording`)).json() as { recording: boolean };
    expect(status.recording).toBe(true);
  });

  test("codec and fps come from the query string and are validated", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(calls), hid: hid() }));

    expect((await fetch(`${base}/recording/start?codec=vp9`, { method: "POST" })).status).toBe(400);
    expect((await fetch(`${base}/recording/start?fps=0`, { method: "POST" })).status).toBe(400);
    expect((await fetch(`${base}/recording/start?codec=hevc&fps=30`, { method: "POST" })).status).toBe(200);
    expect(calls.starts[0]!.options).toEqual({ codec: "hevc", fps: 30, rotation: 0 });
  });

  test("a second start while recording is a conflict", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(calls), hid: hid() }));
    expect((await fetch(`${base}/recording/start`, { method: "POST" })).status).toBe(200);
    const res = await fetch(`${base}/recording/start`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(calls.starts).toHaveLength(1);
  });

  test("stop returns the MP4 as a download and removes the temp file", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(calls), hid: hid() }));
    await fetch(`${base}/recording/start`, { method: "POST" });

    const res = await fetch(`${base}/recording/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="serve-sim-recording-[0-9-]+\.mp4"$/);
    expect(JSON.parse(res.headers.get("x-serve-sim-recording")!)).toMatchObject({ width: 1206, height: 2622, fps: 60 });
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("fake-mp4");
    // The temp file is removed once the response stream closes server-side.
    const tempPath = calls.starts[0]!.path;
    for (let i = 0; i < 100 && existsSync(tempPath); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(existsSync(tempPath)).toBe(false);

    expect(await (await fetch(`${base}/recording`)).json()).toEqual({ recording: false });
  });

  test("stop without an active recording is a conflict", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(calls), hid: hid() }));
    expect((await fetch(`${base}/recording/stop`, { method: "POST" })).status).toBe(409);
    expect(calls.stops).toBe(0);
  });

  test("start and stop require POST", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(calls), hid: hid() }));
    expect((await fetch(`${base}/recording/start`)).status).toBe(405);
    expect((await fetch(`${base}/recording/stop`)).status).toBe(405);
    expect(calls.starts).toHaveLength(0);
  });

  test("a native start failure is reported and leaves the session idle", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", {
      capture: fakeCapture(calls, { startRecording: async () => { throw new Error("Capture is not running"); } }),
      hid: hid(),
    }));
    const res = await fetch(`${base}/recording/start`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "recording_failed", message: "Capture is not running" });
    expect(await (await fetch(`${base}/recording`)).json()).toEqual({ recording: false });
  });

  test("landscape recordings carry the display rotation", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    let setSize!: (size: { width: number; height: number }) => void;
    const session = new DeviceSession("TEST-UDID", {
      capture: fakeCapture(calls, {}, (cb) => { setSize = cb; }),
      hid: hid(true),
    });
    const base = await serve(session);
    await session.start();
    setSize({ width: 1206, height: 2622 });
    session.attachHidSocket({
      send() {},
      close() {},
      on(event, cb) {
        if (event === "message") {
          (cb as (data: Buffer) => void)(Buffer.concat([Buffer.from([0x07]), Buffer.from('{"orientation":"landscape_left"}')]));
        }
      },
    });
    for (let i = 0; i < 50 && session.screenConfig().orientation !== "landscape_left"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(session.screenConfig().orientation).toBe("landscape_left");
    await fetch(`${base}/recording/start`, { method: "POST" });
    expect(calls.starts[0]!.options.rotation).toBe(90);
  });

  test("closing the session abandons an active recording", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    let cancelled = 0;
    const session = new DeviceSession("TEST-UDID", {
      capture: fakeCapture(calls, { stop: async () => { cancelled++; } }),
      hid: hid(),
    });
    const base = await serve(session);
    await fetch(`${base}/recording/start`, { method: "POST" });
    session.close();
    expect(cancelled).toBe(1);
    expect(session.recordingStatus()).toEqual({ recording: false });
  });
});
