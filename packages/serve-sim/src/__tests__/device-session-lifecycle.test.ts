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
  writableEnded = false;
  destroyed = false;
  writableNeedDrain = false;
  headersSent = false;
  readonly chunks: Buffer[] = [];
  onWrite?: (chunk: Buffer) => boolean | undefined;

  writeHead(): this {
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

function dependencies(
  captureOverrides: Partial<DeviceSessionDependencies["capture"]> = {},
): DeviceSessionDependencies {
  return {
    capture: {
      start: async () => {},
      stop: async () => {},
      subscribeMjpeg: async () => () => {},
      subscribeAvcc: async () => () => {},
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
