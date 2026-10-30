import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "http";
import { existsSync, writeFileSync } from "fs";
import { setTimeout as delay } from "timers/promises";
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
    const body = await res.json() as { recording: boolean; startedAt: string; token: string };
    expect(body.recording).toBe(true);
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.token).toBe("string");
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

  async function waitForRemoval(path: string): Promise<void> {
    for (let i = 0; i < 100 && existsSync(path); i++) await delay(5);
  }

  test("a native stop failure removes the partial temp file", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", {
      capture: fakeCapture(calls, {
        stopRecording: async () => {
          calls.stops++;
          writeFileSync(calls.starts[0]!.path, "partial");
          throw new Error("Recording failed: encoder died");
        },
      }),
      hid: hid(),
    }));
    await fetch(`${base}/recording/start`, { method: "POST" });
    const res = await fetch(`${base}/recording/stop`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "recording_failed", message: "Recording failed: encoder died" });
    expect(existsSync(calls.starts[0]!.path)).toBe(false);
    expect(await (await fetch(`${base}/recording`)).json()).toEqual({ recording: false });
  });

  test("a missing output file after finalize is reported and leaves the session idle", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", {
      capture: fakeCapture(calls, { stopRecording: async () => { calls.stops++; return "{}"; } }),
      hid: hid(),
    }));
    await fetch(`${base}/recording/start`, { method: "POST" });
    const res = await fetch(`${base}/recording/stop`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("recording_failed");
    expect(existsSync(calls.starts[0]!.path)).toBe(false);
    expect(await (await fetch(`${base}/recording`)).json()).toEqual({ recording: false });
  });

  test("closing the session while a start is in flight answers 409 and drops the file", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    let session!: DeviceSession;
    session = new DeviceSession("TEST-UDID", {
      capture: fakeCapture(calls, {
        startRecording: async (path, options) => {
          calls.starts.push({ path, options });
          writeFileSync(path, "partial");
          session.close();
        },
      }),
      hid: hid(),
    });
    const base = await serve(session);
    const res = await fetch(`${base}/recording/start`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("session_closed");
    await waitForRemoval(calls.starts[0]!.path);
    expect(existsSync(calls.starts[0]!.path)).toBe(false);
    expect(session.recordingStatus()).toEqual({ recording: false });
  });

  test("a client that disconnects during finalize doesn't leave the file behind", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    let finishStop!: () => void;
    const capture = fakeCapture(calls);
    const realStop = capture.stopRecording!;
    capture.stopRecording = async () => {
      await new Promise<void>((resolve) => { finishStop = resolve; });
      return realStop();
    };
    const base = await serve(new DeviceSession("TEST-UDID", { capture, hid: hid() }));
    await fetch(`${base}/recording/start`, { method: "POST" });
    const abort = new AbortController();
    const pending = fetch(`${base}/recording/stop`, { method: "POST", signal: abort.signal }).catch(() => null);
    for (let i = 0; i < 100 && !finishStop; i++) await delay(5);
    abort.abort();
    expect(await pending).toBeNull();
    await delay(20); // let the server see the socket close
    finishStop();
    const tempPath = calls.starts[0]!.path;
    for (let i = 0; i < 100 && (calls.stops === 0 || existsSync(tempPath)); i++) await delay(5);
    expect(calls.stops).toBe(1);
    expect(existsSync(tempPath)).toBe(false);
    expect(await (await fetch(`${base}/recording`)).json()).toEqual({ recording: false });
  });

  test("closing the session mid-stop leaves the file for the stop to stream", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    let finishStop!: () => void;
    const capture = fakeCapture(calls);
    const realStop = capture.stopRecording!;
    capture.stopRecording = async () => {
      writeFileSync(calls.starts[0]!.path, "in-progress");
      await new Promise<void>((resolve) => { finishStop = resolve; });
      return realStop();
    };
    const session = new DeviceSession("TEST-UDID", { capture, hid: hid() });
    const base = await serve(session);
    await fetch(`${base}/recording/start`, { method: "POST" });
    const pending = fetch(`${base}/recording/stop`, { method: "POST" });
    for (let i = 0; i < 100 && !finishStop; i++) await delay(5);
    session.close();
    await delay(20);
    expect(existsSync(calls.starts[0]!.path)).toBe(true);
    finishStop();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("fake-mp4");
  });

  test("the server caps recording length and holds the file for stop", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", {
      capture: fakeCapture(calls),
      hid: hid(),
      maxRecordingMs: 20,
    }));
    const { token } = await (await fetch(`${base}/recording/start`, { method: "POST" })).json() as { token: string };
    for (let i = 0; i < 100 && calls.stops === 0; i++) await delay(5);
    expect(calls.stops).toBe(1);
    const status = await (await fetch(`${base}/recording`)).json() as Record<string, unknown>;
    expect(status).toMatchObject({ recording: true, limitReached: true });
    expect(status.token).toBeUndefined();
    // A second start still conflicts until the capped file is collected.
    expect((await fetch(`${base}/recording/start`, { method: "POST" })).status).toBe(409);

    // Only the client that started it may collect the held file.
    for (const query of ["", "?token=someone-else"]) {
      const other = await fetch(`${base}/recording/stop${query}`, { method: "POST" });
      expect(other.status).toBe(409);
      expect(await other.json()).toMatchObject({ error: "not_owner", limitReached: true });
    }

    const res = await fetch(`${base}/recording/stop?token=${token}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("fake-mp4");
    expect(calls.stops).toBe(1);
    expect(await (await fetch(`${base}/recording`)).json()).toEqual({ recording: false });
  });

  async function startAndHitCap(base: string, calls: RecordingCalls): Promise<{ token: string }> {
    const body = await (await fetch(`${base}/recording/start`, { method: "POST" })).json() as { token: string };
    for (let i = 0; i < 100 && calls.stops === 0; i++) await delay(5);
    expect(calls.stops).toBe(1);
    return body;
  }

  test("a capped file reports when its owner's hold ends", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", {
      capture: fakeCapture(calls),
      hid: hid(),
      maxRecordingMs: 20,
      recordingHoldMs: 60_000,
    }));
    const before = Date.now();
    await startAndHitCap(base, calls);
    let status: { holdExpiresAt?: string } = {};
    for (let i = 0; i < 50 && !status.holdExpiresAt; i++) {
      status = await (await fetch(`${base}/recording`)).json() as typeof status;
    }
    const expires = Date.parse(status.holdExpiresAt!);
    expect(expires).toBeGreaterThanOrEqual(before + 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test("once the hold expires, any client may collect the capped file", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", {
      capture: fakeCapture(calls),
      hid: hid(),
      maxRecordingMs: 20,
      recordingHoldMs: 40,
    }));
    await startAndHitCap(base, calls);
    // Still the owner's: the starting tab reloaded and lost the token.
    expect((await fetch(`${base}/recording/stop`, { method: "POST" })).status).toBe(409);
    await delay(80);
    const res = await fetch(`${base}/recording/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("fake-mp4");
    expect(await (await fetch(`${base}/recording`)).json()).toEqual({ recording: false });
  });

  test("a start after the hold expires discards the capped file and records again", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    // Only the first recording runs into the cap.
    const deps: DeviceSessionDependencies = { capture: fakeCapture(calls), hid: hid(), maxRecordingMs: 20, recordingHoldMs: 40 };
    const base = await serve(new DeviceSession("TEST-UDID", deps));
    await startAndHitCap(base, calls);
    deps.maxRecordingMs = 60_000;
    const held = calls.starts[0]!.path;
    expect(existsSync(held)).toBe(true);
    // Within the hold the device stays reserved.
    expect((await fetch(`${base}/recording/start`, { method: "POST" })).status).toBe(409);
    await delay(80);
    const res = await fetch(`${base}/recording/start`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(existsSync(held)).toBe(false);
    expect(calls.starts).toHaveLength(2);
    expect(await (await fetch(`${base}/recording`)).json()).toMatchObject({ recording: true });
    expect((await (await fetch(`${base}/recording`)).json() as Record<string, unknown>).limitReached).toBeUndefined();
  });

  test("the owner can still collect after the hold expires", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", {
      capture: fakeCapture(calls),
      hid: hid(),
      maxRecordingMs: 20,
      recordingHoldMs: 20,
    }));
    const { token } = await startAndHitCap(base, calls);
    await delay(60);
    const res = await fetch(`${base}/recording/stop?token=${token}`, { method: "POST" });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  test("any client may stop a recording that is still running", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const base = await serve(new DeviceSession("TEST-UDID", { capture: fakeCapture(calls), hid: hid() }));
    await fetch(`${base}/recording/start`, { method: "POST" });
    const res = await fetch(`${base}/recording/stop?token=stale`, { method: "POST" });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  test("an addon without recording answers 501", async () => {
    const calls: RecordingCalls = { starts: [], stops: 0 };
    const capture = fakeCapture(calls);
    const base = await serve(new DeviceSession("TEST-UDID", {
      capture: { ...capture, supportsRecording: false },
      hid: hid(),
    }));
    const res = await fetch(`${base}/recording/start`, { method: "POST" });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: "recording_unsupported" });
    expect(calls.starts).toHaveLength(0);
  });
});
