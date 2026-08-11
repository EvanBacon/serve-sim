import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "http";
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

describe("DeviceSession lifecycle health", () => {
  test("turns an async native start rejection into a 503 response", async () => {
    const session = new DeviceSession("TEST-UDID", dependencies({
      start: async () => { throw new Error("Device not booted (state: Shutdown)"); },
    }));
    const baseUrl = await serve(session);

    const stream = await fetch(`${baseUrl}/stream.mjpeg`);
    expect(stream.status).toBe(503);
    expect(await stream.json()).toEqual({
      error: "capture_unavailable",
      message: "Device not booted (state: Shutdown)",
    });

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(503);
    expect((await health.json()).status).toBe("failed");
  });

  test("retains failure diagnostics and allows a later startup retry", async () => {
    let startCalls = 0;
    const session = new DeviceSession("TEST-UDID", dependencies({
      start: async () => {
        startCalls++;
        if (startCalls === 1) throw new Error("Device not booted");
      },
    }));

    await expect(session.start()).rejects.toThrow("Device not booted");
    const baseUrl = await serve(session);
    const failed = await fetch(`${baseUrl}/health`);
    expect(failed.status).toBe(503);
    expect((await failed.json()).status).toBe("failed");

    await expect(session.start()).resolves.toBeUndefined();
    expect(startCalls).toBe(2);
  });

  test("closing during startup cannot resurrect the session", async () => {
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

    const starting = session.start();
    await startCalled;
    const closing = session.close();
    rejectStart(new Error("Device not booted (state: Shutting Down)"));

    await expect(starting).rejects.toThrow("Shutting Down");
    await closing;
    expect(stopCalls).toBe(1);

    const baseUrl = await serve(session);
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(503);
    expect((await health.json()).status).toBe("stopped");
  });

  test("becomes ready only after capture produces a frame", async () => {
    let sharedFrame!: (frame: { data: Uint8Array; width: number; height: number }) => Promise<void>;
    const session = new DeviceSession("TEST-UDID", dependencies({
      subscribeMjpeg: async (callback) => {
        sharedFrame ??= callback;
        return async () => {};
      },
    }));
    await session.start();
    const baseUrl = await serve(session);

    const starting = await fetch(`${baseUrl}/health`);
    expect(starting.status).toBe(425);
    expect((await starting.json()).status).toBe("starting");

    await sharedFrame({
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      width: 1_206,
      height: 2_622,
    });
    const ready = await fetch(`${baseUrl}/health`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: "ok",
      ready: true,
      device: "TEST-UDID",
      screen: { width: 1_206, height: 2_622, orientation: "portrait" },
      frames: { mjpeg: 1, avcc: 0, lastCodec: "mjpeg" },
    });

    await session.close();
  });

  test("reports native teardown errors without rejecting shutdown", async () => {
    const session = new DeviceSession("TEST-UDID", dependencies({
      stop: async () => { throw new Error("native teardown failed"); },
    }));

    await expect(session.close()).resolves.toBeUndefined();
  });
});

function dependencies(
  captureOverrides: Partial<DeviceSessionDependencies["capture"]> = {},
): DeviceSessionDependencies {
  return {
    capture: {
      start: async () => {},
      stop: async () => {},
      subscribeMjpeg: async () => async () => {},
      subscribeAvcc: async () => async () => {},
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
