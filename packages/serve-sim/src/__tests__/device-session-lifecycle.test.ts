import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { createServer, type Server } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import type { AddressInfo } from "net";
import {
  DeviceSession,
  type DeviceSessionDependencies,
} from "../device-session";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

describe("DeviceSession capture lifecycle", () => {
  test("a capture start rejection returns 503 instead of becoming unhandled", async () => {
    const session = new DeviceSession("TEST-UDID", dependencies({
      start: async () => { throw new Error("Device not booted (state: Shutting Down)"); },
    }));
    const baseUrl = await serve(session);

    const response = await fetch(`${baseUrl}/stream.mjpeg`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "capture_unavailable",
      message: "Device not booted (state: Shutting Down)",
    });
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  test("closing while capture starts cannot resurrect or crash the session", async () => {
    let rejectStart!: (error: Error) => void;
    let notifyStartCalled!: () => void;
    let stopCalls = 0;
    const pendingStart = new Promise<void>((_resolve, reject) => { rejectStart = reject; });
    const startCalled = new Promise<void>((resolve) => { notifyStartCalled = resolve; });
    const session = new DeviceSession("TEST-UDID", dependencies({
      start: () => {
        notifyStartCalled();
        return pendingStart;
      },
      stop: async () => { stopCalls++; },
    }));
    const baseUrl = await serve(session);

    const streamResponse = fetch(`${baseUrl}/stream.mjpeg`);
    await startCalled;
    session.close();
    rejectStart(new Error("Device not booted (state: Shutting Down)"));

    expect((await streamResponse).status).toBe(503);
    expect(stopCalls).toBe(1);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  test("a static simulator replays its cached JPEG to keep MJPEG clients live", async () => {
    const callbacks: Array<(frame: { data: Uint8Array; width: number; height: number }) => Promise<void>> = [];
    const session = new DeviceSession("TEST-UDID", dependencies({
      subscribeMjpeg: async (callback) => {
        callbacks.push(callback);
        return () => {};
      },
    }));
    await session.start();
    await callbacks[0]!({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 10, height: 20 });

    const baseUrl = await serve(session);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/stream.mjpeg?raw=1`, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder("latin1");
    let wire = "";
    const deadline = Date.now() + 5_000;
    while ((wire.match(/Content-Length:/g)?.length ?? 0) < 2 && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_250)),
      ]);
      if (!chunk || chunk.done) break;
      wire += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    await reader.cancel().catch(() => {});
    session.close();

    expect(wire.match(/Content-Length:/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("holds a native JPEG buffer until HTTP backpressure drains", async () => {
    const callbacks: Array<(frame: { data: Uint8Array; width: number; height: number }) => Promise<void>> = [];
    const session = new DeviceSession("TEST-UDID", dependencies({
      subscribeMjpeg: async (callback) => {
        callbacks.push(callback);
        return () => {};
      },
    }));
    await session.start();

    const response = new FakeServerResponse();
    session.handleMjpeg(
      { url: "/stream.mjpeg" } as IncomingMessage,
      response as unknown as ServerResponse,
    );
    await waitFor(() => callbacks.length === 2);

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    response.onWrite = (chunk) => {
      if (!chunk.equals(jpeg)) return;
      response.writableNeedDrain = true;
      return false;
    };
    let callbackSettled = false;
    const delivery = callbacks[1]!({
      data: jpeg,
      width: 10,
      height: 20,
    }).then(() => { callbackSettled = true; });
    await Promise.resolve();
    expect(callbackSettled).toBe(false);

    response.writableNeedDrain = false;
    response.emit("drain");
    await delivery;
    expect(callbackSettled).toBe(true);
    expect(Buffer.concat(response.chunks).includes(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);

    response.writableEnded = true;
    response.emit("close");
    session.close();
  });

  test("holds a native AVCC buffer until its queued write drains", async () => {
    const callbacks: Array<(frame: {
      data: Uint8Array;
      width: number;
      height: number;
      isDescription: boolean;
      isKeyframe: boolean;
    }) => Promise<void>> = [];
    const session = new DeviceSession("TEST-UDID", dependencies({
      subscribeAvcc: async (callback) => {
        callbacks.push(callback);
        return () => {};
      },
    }));
    await session.start();

    const response = new FakeServerResponse();
    const payload = Buffer.from([0, 0, 0, 1, 0x65]);
    response.onWrite = (chunk) => {
      if (!chunk.equals(payload)) return;
      response.writableNeedDrain = true;
      return false;
    };
    session.handleAvcc(
      {} as IncomingMessage,
      response as unknown as ServerResponse,
    );
    await waitFor(() => callbacks.length === 1);

    let callbackSettled = false;
    const delivery = callbacks[0]!({
      data: payload,
      width: 10,
      height: 20,
      isDescription: false,
      isKeyframe: true,
    }).then(() => { callbackSettled = true; });
    await Promise.resolve();
    expect(callbackSettled).toBe(false);

    response.writableNeedDrain = false;
    response.emit("drain");
    await delivery;
    expect(callbackSettled).toBe(true);

    response.destroy();
    session.close();
  });

  test("closing a session terminates active streams and unsubscribes them", async () => {
    const callbacks: Array<(frame: { data: Uint8Array; width: number; height: number }) => Promise<void>> = [];
    const unsubscribed: number[] = [];
    const session = new DeviceSession("TEST-UDID", dependencies({
      subscribeMjpeg: async (callback) => {
        callbacks.push(callback);
        const subscription = callbacks.length;
        return () => { unsubscribed.push(subscription); };
      },
    }));
    await session.start();

    const response = new FakeServerResponse();
    session.handleMjpeg(
      { url: "/stream.mjpeg" } as IncomingMessage,
      response as unknown as ServerResponse,
    );
    await waitFor(() => callbacks.length === 2);

    session.close();
    await waitFor(() => response.destroyed && unsubscribed.length === 2);
    expect(unsubscribed.sort()).toEqual([1, 2]);
  });
});

class FakeServerResponse extends EventEmitter {
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  writableNeedDrain = false;
  headersSent = false;
  headers: Record<string, string> = {};
  readonly chunks: Buffer[] = [];
  onWrite?: (chunk: Buffer) => boolean | undefined;

  writeHead(_status = 200, headers: Record<string, string> = {}): this {
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  write(chunk: Uint8Array | string): boolean {
    const buffer = Buffer.from(chunk);
    this.chunks.push(buffer);
    const accepted = this.onWrite?.(buffer);
    if (accepted != null) return accepted;
    return !this.writableNeedDrain;
  }

  end(chunk?: Uint8Array | string): this {
    if (chunk) this.chunks.push(Buffer.from(chunk));
    this.writableEnded = true;
    this.emit("close");
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("DeviceSession fold pose HID", () => {
  test("tag 0x0e named pose injects hinge and follows the active panel", async () => {
    const poses: string[] = [];
    const sizes: Array<[number, number]> = [];
    const hid = dependencies().hid;
    const session = new DeviceSession("TEST-UDID", {
      capture: {
        ...dependencies().capture,
        setPreferredScreenSize: async (width, height) => {
          sizes.push([width, height]);
        },
      },
      hid: {
        ...hid,
        pose: async (name) => {
          poses.push(name);
          return true;
        },
      },
    });

    const listeners = new Map<string, Array<(data: Buffer) => void>>();
    session.attachHidSocket({
      send() {},
      on(event, cb) {
        listeners.set(event, [...(listeners.get(event) ?? []), cb as (data: Buffer) => void]);
      },
      close() {},
    });

    const payload = Buffer.from(JSON.stringify({ pose: "open" }));
    const frame = Buffer.concat([Buffer.from([0x0e]), payload]);
    for (const cb of listeners.get("message") ?? []) cb(frame);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(poses).toEqual(["open"]);
    expect(sizes).toEqual([[2007, 2853]]);
  });

  test("pose requests serialize across sockets and acknowledge completed capture selection", async () => {
    const events: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const session = new DeviceSession("TEST-UDID", {
      ...dependencies(),
      capture: { ...dependencies().capture, setPreferredScreenSize: async (width) => { events.push(`capture:${width}`); } },
      hid: { ...dependencies().hid, pose: async (name) => {
        events.push(name);
        if (name === "open") await pending;
        return true;
      } },
    });
    for (const name of ["open", "closed"]) {
      let receive!: (data: Buffer) => void;
      session.attachHidSocket({
        send(frame) { events.push(`reply:${JSON.parse(frame.subarray(1).toString()).ok}`); },
        close() {},
        on(event, cb) { if (event === "message") receive = cb as (data: Buffer) => void; },
      });
      receive(Buffer.concat([Buffer.from([0x0e]), Buffer.from(JSON.stringify({ pose: name }))]));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(["open"]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(["open", "capture:2007", "reply:true", "closed", "capture:1398", "reply:true"]);
  });

  test("live hinge readback continues while a named pose is sweeping", async () => {
    let update!: (state: import("../duo-state").DuoState) => void;
    let receive!: (data: Buffer) => void;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const starts: number[] = [];
    const session = new DeviceSession("TEST-UDID", {
      ...dependencies(),
      hid: { ...dependencies().hid, isFoldable: async () => true,
        pose: async (_name, from) => { starts.push(from!); await pending; return true; } },
      createDuoMonitor: (_udid, onState) => { update = onState; return { close() {}, refreshOrientation() {} }; },
    });
    await session.start();
    update({ hingeDegrees: 20, orientations: {} });
    await waitFor(() => session.screenConfig().hingeDegrees === 20);
    session.attachHidSocket({ send() {}, close() {}, on(event, cb) {
      if (event === "message") receive = cb as (data: Buffer) => void;
    } });
    receive(Buffer.concat([Buffer.from([0x0e]), Buffer.from(JSON.stringify({ pose: "open" }))]));
    await waitFor(() => starts.length === 1);
    update({ hingeDegrees: 65, orientations: {} });
    try {
      await waitFor(() => session.screenConfig().hingeDegrees === 65);
      expect(starts).toEqual([20]);
    } finally {
      release();
      await session.close();
    }
  });

  test("failed and invalid poses do not switch the captured panel", async () => {
    const sizes: number[] = [];
    const poses: string[] = [];
    const replies: boolean[] = [];
    const hinges: number[] = [];
    const session = new DeviceSession("TEST-UDID", {
      ...dependencies(),
      capture: { ...dependencies().capture, setPreferredScreenSize: async (w) => { sizes.push(w); } },
      hid: { ...dependencies().hid,
        pose: async (name) => { poses.push(name); return false; },
        hinge: async (degrees) => { hinges.push(degrees); return false; },
      },
    });
    const listeners: Array<(data: Buffer) => void> = [];
    session.attachHidSocket({ send(frame) { replies.push(JSON.parse(frame.subarray(1).toString()).ok); }, close() {}, on(event, cb) {
      if (event === "message") listeners.push(cb as (data: Buffer) => void);
    } });
    for (const payload of [{ pose: "open" }, { pose: "invalid" }, { hinge: 90 }, { hinge: -1 }, { hinge: 181 }]) {
      for (const cb of listeners) cb(Buffer.concat([Buffer.from([0x0e]), Buffer.from(JSON.stringify(payload))]));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(poses).toEqual(["open"]);
    expect(hinges).toEqual([90]);
    expect(sizes).toEqual([]);
    expect(replies).toEqual([false, false, false, false, false]);
  });

  test("tag 0x0e raw hinge uses the cover framebuffer below 90°", async () => {
    const hinges: number[] = [];
    const sizes: Array<[number, number]> = [];
    const session = new DeviceSession("TEST-UDID", {
      capture: {
        ...dependencies().capture,
        setPreferredScreenSize: async (width, height) => {
          sizes.push([width, height]);
        },
      },
      hid: {
        ...dependencies().hid,
        hinge: async (degrees) => {
          hinges.push(degrees);
          return true;
        },
      },
    });

    const listeners = new Map<string, Array<(data: Buffer) => void>>();
    session.attachHidSocket({
      send() {},
      on(event, cb) {
        listeners.set(event, [...(listeners.get(event) ?? []), cb as (data: Buffer) => void]);
      },
      close() {},
    });

    const payload = Buffer.from(JSON.stringify({ hinge: 0 }));
    const frame = Buffer.concat([Buffer.from([0x0e]), payload]);
    for (const cb of listeners.get("message") ?? []) cb(frame);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(hinges).toEqual([0]);
    expect(sizes).toEqual([[1398, 2034]]);
  });
});

test("3D attach and hinge updates render cached frames; stale worker failures cannot close a replacement", async () => {
  const frames: Array<(frame: { data: Uint8Array; width: number; height: number }) => Promise<void>> = [];
  let update!: (state: import("../duo-state").DuoState) => void;
  const workers: Array<{ closeCalls: number; angles: number[]; reject?: (error: Error) => void }> = [];
  const session = new DeviceSession("TEST-UDID", {
    ...dependencies({ subscribeMjpeg: async (cb) => { frames.push(cb); return () => {}; } }),
    hid: { ...dependencies().hid, isFoldable: async () => true },
    createDuoMonitor: (_udid, onState) => { update = onState; return { close() {}, refreshOrientation() {} }; },
    createDuoRenderer: () => {
      const state: (typeof workers)[number] = { closeCalls: 0, angles: [] };
      workers.push(state);
      return {
        close() { state.closeCalls++; },
        render: async (_jpeg, panel, hingeDegrees) => {
          state.angles.push(hingeDegrees);
          if (workers.indexOf(state) === 0) await new Promise<void>((_resolve, reject) => { state.reject = reject; });
          return { jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), projection: { width: 1000, height: 900, panel, hingeDegrees, pieces: [] } };
        },
      };
    },
  });
  await session.start();
  update({ hingeDegrees: 130, orientations: {} });
  await frames[0]!({ data: new Uint8Array([1, 2, 3]), width: 2007, height: 2853 });
  const first = new FakeServerResponse();
  session.handleDuoMjpeg({ url: "/stream.3d.mjpeg?raw=1" } as IncomingMessage, first as unknown as ServerResponse);
  await waitFor(() => workers[0]?.angles.length === 1);
  expect(first.headers["Content-Type"]).toBe("application/octet-stream");
  first.destroy();
  const second = new FakeServerResponse();
  session.handleDuoMjpeg({} as IncomingMessage, second as unknown as ServerResponse);
  await waitFor(() => second.chunks.length > 0);
  workers[0]!.reject!(new Error("old worker exited"));
  update({ hingeDegrees: 140, orientations: {} });
  await waitFor(() => workers[1]!.angles.includes(140));
  expect(workers[0]!.angles).toEqual([130]);
  expect(workers[1]!.closeCalls).toBe(0);
  expect(second.destroyed).toBe(false);
  session.close();
  expect(second.destroyed).toBe(true);
});

test("Duo rotation redraws a static frame in all four orientations and ignores rejected input", async () => {
  let frame!: (value: { data: Uint8Array; width: number; height: number }) => Promise<void>;
  let update!: (state: import("../duo-state").DuoState) => void;
  let message!: (data: Buffer) => void;
  let accepted = true;
  const rolls: number[] = [];
  const qualities: boolean[] = [];
  const session = new DeviceSession("TEST-UDID", {
    ...dependencies({ subscribeMjpeg: async (cb) => { frame = cb; return () => {}; } }),
    hid: { ...dependencies().hid, isFoldable: async () => true, orientation: async () => accepted },
    createDuoMonitor: (_udid, onState) => { update = onState; return { close() {}, refreshOrientation() {} }; },
    createDuoRenderer: () => ({
      close() {},
      render: async (_jpeg, panel, hingeDegrees, roll, fullResolution = false) => {
        qualities.push(fullResolution);
        rolls.push(roll);
        return { jpeg: Buffer.from([1]), projection: { width: 3000, height: 2700, panel, hingeDegrees, pieces: [] } };
      },
    }),
  });
  await session.start();
  session.attachHidSocket({ send() {}, close() {}, on(event, cb) { if (event === "message") message = cb; } });
  const response = new FakeServerResponse();
  try {
    update({ hingeDegrees: 180, primaryPanel: "inner", orientations: { inner: "portrait" } });
    await frame({ data: new Uint8Array([1]), width: 2007, height: 2853 });
    session.handleDuoMjpeg({} as IncomingMessage, response as unknown as ServerResponse);
    await waitFor(() => rolls.length > 0);
    expect(rolls.at(-1)).toBe(0);
    for (const [orientation, roll] of [["landscape_left", -90], ["portrait_upside_down", -180], ["landscape_right", 90], ["portrait", 0]] as const) {
      const count = rolls.length;
      message(Buffer.concat([Buffer.from([0x07]), Buffer.from(JSON.stringify({ orientation }))]));
      await waitFor(() => rolls.length > count && rolls.at(-1) === roll);
      expect(rolls.slice(count).some((value) => value !== roll)).toBe(true);
      expect(rolls.at(-1)).toBe(roll);
      expect(session.screenConfig().orientation).toBe(orientation);
    }
    accepted = false;
    message(Buffer.concat([Buffer.from([0x07]), Buffer.from('{"orientation":"landscape_left"}')]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(session.screenConfig().orientation).toBe("portrait");
    expect(rolls.at(-1)).toBe(0);
    // Folding changes the active panel and guest orientation, never the view roll.
    for (const [hingeDegrees, primaryPanel, width, height] of [[130, "inner", 2007, 2853], [0, "cover", 1398, 2034], [180, "inner", 2007, 2853]] as const) {
      const count = rolls.length;
      update({ hingeDegrees, primaryPanel, orientations: { inner: "landscape_right", cover: "portrait" } });
      await frame({ data: new Uint8Array([1]), width, height });
      await waitFor(() => rolls.length > count);
      expect(rolls.at(-1)).toBe(0);
      expect(session.screenConfig().duoViewOrientation).toBe("portrait");
    }
    // Rotate still works when the requested orientation matches guest readback.
    accepted = true;
    const count = rolls.length;
    message(Buffer.concat([Buffer.from([0x07]), Buffer.from('{"orientation":"landscape_right"}')]));
    await waitFor(() => rolls.length > count && rolls.at(-1) === 90);
    expect(rolls.at(-1)).toBe(90);
    expect(qualities.at(-1)).toBe(false);
    await waitFor(() => qualities.at(-1) === true);
    const countBeforeFrame = qualities.length;
    await frame({ data: new Uint8Array([2]), width: 2007, height: 2853 });
    await waitFor(() => qualities.length > countBeforeFrame);
    expect(qualities.at(-1)).toBe(false);
  } finally { session.close(); }
});

test("guest primary panel wins over hinge heuristics in both fold directions", async () => {
  let update!: (state: import("../duo-state").DuoState) => void;
  const sizes: number[] = [];
  const session = new DeviceSession("TEST-UDID", {
    ...dependencies({ setPreferredScreenSize: async (width) => { sizes.push(width); } }),
    hid: { ...dependencies().hid, isFoldable: async () => true },
    createDuoMonitor: (_udid, onState) => { update = onState; return { close() {}, refreshOrientation() {} }; },
  });
  await session.start();
  update({ hingeDegrees: 0, primaryPanel: "cover", orientations: {} });
  update({ hingeDegrees: 130, primaryPanel: "cover", orientations: {} });
  update({ hingeDegrees: 180, primaryPanel: "inner", orientations: {} });
  update({ hingeDegrees: 80, primaryPanel: "inner", orientations: {} });
  update({ hingeDegrees: 0, primaryPanel: "cover", orientations: {} });
  await waitFor(() => sizes.length === 3);
  expect(sizes).toEqual([1398, 2007, 1398]);
  session.close();
});

function dependencies(
  captureOverrides: Partial<DeviceSessionDependencies["capture"]> = {},
): DeviceSessionDependencies {
  return {
    capture: {
      start: async () => {},
      stop: async () => {},
      subscribeMjpeg: async () => () => {},
      subscribeAvcc: async () => () => {},
      setPreferredScreenSize: async () => {},
      ...captureOverrides,
    },
    hid: {
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
    },
  };
}

async function serve(session: DeviceSession): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url === "/health") session.handleHealth(req, res);
    else session.handleMjpeg(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
