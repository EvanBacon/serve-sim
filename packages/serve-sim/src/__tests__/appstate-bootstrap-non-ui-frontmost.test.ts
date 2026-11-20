import * as realChildProcess from "child_process";
import { EventEmitter } from "events";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { createServer, request, type Server } from "http";
import type { AddressInfo } from "net";
import { PassThrough } from "stream";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as realNative from "../native";
import { resolveDeviceSet } from "../simctl";
import { STATE_DIR, stateFileForDevice } from "../state";

// `GET /appstate` first asks AX for the frontmost app and emits it, then tails
// SpringBoard's log for later foreground changes. When the frontmost app is
// not a user-facing bundle (its id matches the widget/extension/service
// filter, e.g. `com.example.fieldservice`), only the bootstrap event should be
// skipped. Measured on a real simulator, the handler instead returned before
// spawning the tail: the SSE response stayed open but never carried another
// event (0 of 5 app launches reported).

// A label, not a UDID, so readServeSimStates never recycles the state.
const DEVICE = "APPSTATE-BOOTSTRAP-NON-UI-TEST";

type FakeTail = EventEmitter & { stdout: PassThrough; killed: boolean; kill: () => boolean };
const tails: FakeTail[] = [];
let frontmost: { bundleId?: string; pid?: number } = {};
let interceptBootedList = true;

const isOurTail = (args: unknown) =>
  Array.isArray(args) && args.includes(DEVICE) && args.includes("log") && args.includes("stream");

// Captured before mocking: the namespace imports are live-patched by mock.module.
const realSpawn = realChildProcess.spawn as (...a: unknown[]) => unknown;
const realExecFile = realChildProcess.execFile as (...a: unknown[]) => unknown;
const realAxFrontmostAsync = realNative.axFrontmostAsync;

function execFile(file: string, args: string[], options: unknown, callback?: (...a: unknown[]) => void) {
  const cb = (typeof options === "function" ? options : callback) as (...a: unknown[]) => void;
  // Fails `simctl list devices booted`, which keeps the state (simctl could
  // not prove the device gone).
  if (interceptBootedList && Array.isArray(args) && args.includes("list") && args.includes("booted")) {
    queueMicrotask(() => cb(new Error("simctl stubbed by test"), "", ""));
    return new EventEmitter();
  }
  if (Array.isArray(args) && args.includes("get_app_container") && args.includes(DEVICE)) {
    queueMicrotask(() => cb(new Error("no app container in test"), "", ""));
    return new EventEmitter();
  }
  return realExecFile(file, args, options, callback);
}
Object.assign(execFile, { [promisify.custom]: (realChildProcess.execFile as unknown as Record<symbol, unknown>)[promisify.custom] });

// Both mocks delegate to the real modules for anything but this test's device.
mock.module("child_process", () => ({
  ...realChildProcess,
  spawn: (file: string, args: string[], options: unknown) => {
    if (!isOurTail(args)) return realSpawn(file, args, options);
    const tail = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      killed: false,
      kill() {
        if (tail.killed) return true;
        tail.killed = true;
        queueMicrotask(() => tail.emit("close", null, "SIGTERM"));
        return true;
      },
    }) as FakeTail;
    tails.push(tail);
    return tail;
  },
  execFile,
}));
mock.module("../native", () => ({
  ...realNative,
  axFrontmostAsync: (udid: string) =>
    udid === DEVICE ? Promise.resolve(JSON.stringify(frontmost)) : realAxFrontmostAsync(udid),
}));

const { simMiddleware } = await import("../middleware");

const stateFile = stateFileForDevice(DEVICE);
let server: Server;
let port: number;

beforeAll(async () => {
  mkdirSync(STATE_DIR, { recursive: true });
  const deviceSet = resolveDeviceSet();
  writeFileSync(stateFile, JSON.stringify({
    pid: process.pid,
    port: 1,
    device: DEVICE,
    url: "",
    streamUrl: "",
    wsUrl: "",
    ...(deviceSet === undefined ? {} : { deviceSet }),
  }));
  const middleware = simMiddleware({ basePath: "/", proxyHelpers: true });
  server = createServer((req, res) => {
    void middleware(req, res, async () => {
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  interceptBootedList = false;
  rmSync(stateFile, { force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const foregroundLine = (bundleId: string, pid: number) =>
  JSON.stringify({ eventMessage: `[app<${bundleId}>:${pid}] Setting process visibility to: Foreground` }) + "\n";

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

function connect() {
  const req = request({ host: "127.0.0.1", port, path: `/appstate?device=${DEVICE}` });
  let body = "";
  req.on("response", (res) => res.on("data", (d) => (body += String(d))));
  req.on("error", () => {});
  req.end();
  const events = () => body.split("\n\n").filter((e) => e.startsWith("data: ")).map((e) => JSON.parse(e.slice(6)));
  return { req, events };
}

describe("GET /appstate bootstrap", () => {
  for (const [name, info] of [
    ["a non-user-facing frontmost app", { bundleId: "com.example.fieldservice", pid: 31 }],
    ["a frontmost app with no bundle id", { pid: 32 }],
  ] as const) {
    test(`${name} skips the bootstrap event but still tails later foreground changes`, async () => {
      tails.length = 0;
      frontmost = info;
      const { req, events } = connect();
      try {
        // Unfixed, the handler returns before spawning: no tail, ever.
        expect(await waitFor(() => tails.length === 1, 3_000)).toBe(true);
        expect(events()).toEqual([]);
        tails[0]!.stdout.write(foregroundLine("com.example.next", 40));
        expect(await waitFor(() => events().length === 1, 3_000)).toBe(true);
        expect(events()).toEqual([{ bundleId: "com.example.next", pid: 40, isReactNative: false }]);
      } finally {
        req.destroy();
      }
      expect(await waitFor(() => tails[0]?.killed === true, 2_000)).toBe(true);
    }, 10_000);
  }

  test("a user-facing frontmost app is emitted first, then tailed changes follow", async () => {
    tails.length = 0;
    frontmost = { bundleId: "com.example.front", pid: 33 };
    const { req, events } = connect();
    try {
      expect(await waitFor(() => tails.length === 1 && events().length === 1, 3_000)).toBe(true);
      expect(events()).toEqual([{ bundleId: "com.example.front", pid: 33, isReactNative: false }]);
      // Re-foregrounding the bootstrapped app is not a change.
      tails[0]!.stdout.write(foregroundLine("com.example.front", 33) + foregroundLine("com.example.next", 41));
      expect(await waitFor(() => events().length === 2, 3_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(events()).toEqual([
        { bundleId: "com.example.front", pid: 33, isReactNative: false },
        { bundleId: "com.example.next", pid: 41, isReactNative: false },
      ]);
    } finally {
      req.destroy();
    }
    expect(await waitFor(() => tails[0]?.killed === true, 2_000)).toBe(true);
  }, 10_000);
});
