import * as realChildProcess from "child_process";
import { EventEmitter } from "events";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { createServer, request, type Server } from "http";
import type { AddressInfo } from "net";
import { PassThrough } from "stream";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { resolveDeviceSet } from "../simctl";
import { STATE_DIR, stateFileForDevice } from "../state";

// `GET /appstate` tails SpringBoard with `simctl spawn <udid> log stream`, a
// process that never exits on its own. The tail is spawned only after an async
// bootstrap (device-state lookup, frontmost-app probe). A client that leaves
// during that bootstrap (a page reload, EventSource reconnect, or `curl
// --max-time`) must not leave a tail behind: measured on a real simulator,
// every such request leaked a host `simctl` plus a guest `log` process that
// outlived the server.

// A label, not a UDID, so readServeSimStates never recycles the state.
const DEVICE = "APPSTATE-LOG-STREAM-TEST";

type FakeTail = EventEmitter & { stdout: PassThrough; killed: boolean; kill: () => boolean };
const tails: FakeTail[] = [];
/**
 * While this file runs, `simctl list devices booted` fails (an uncached
 * lookup that keeps the state: simctl could not prove the device gone),
 * after waiting on `holdBootedList` when that is set.
 */
let interceptBootedList = true;
let holdBootedList: Promise<void> | null = null;
let bootedListReached: () => void = () => {};
/** Set once a drained request (see `x-test-drain-body`) emits 'close' server-side. */
let drainedRequestClosed = false;

const isOurTail = (args: unknown) =>
  Array.isArray(args) && args.includes(DEVICE) && args.includes("log") && args.includes("stream");

// Captured before mocking: the namespace import is live-patched by mock.module.
const realSpawn = realChildProcess.spawn as (...a: unknown[]) => unknown;
const realExecFile = realChildProcess.execFile as (...a: unknown[]) => unknown;

function execFile(file: string, args: string[], options: unknown, callback?: (...a: unknown[]) => void) {
  const cb = (typeof options === "function" ? options : callback) as (...a: unknown[]) => void;
  if (interceptBootedList && Array.isArray(args) && args.includes("list") && args.includes("booted")) {
    bootedListReached();
    void (holdBootedList ?? Promise.resolve()).then(() => cb(new Error("simctl stubbed by test"), "", ""));
    return new EventEmitter();
  }
  if (Array.isArray(args) && args.includes("get_app_container") && args.includes(DEVICE)) {
    queueMicrotask(() => cb(new Error("no app container in test"), "", ""));
    return new EventEmitter();
  }
  return realExecFile(file, args, options, callback);
}
// `promisify(execFile)` callers elsewhere still get `{ stdout, stderr }`.
Object.assign(execFile, { [promisify.custom]: (realChildProcess.execFile as unknown as Record<symbol, unknown>)[promisify.custom] });

// Delegates to the real module except for this test's own device and the
// booted-list stub, so it is harmless to other files sharing the process.
mock.module("child_process", () => ({
  ...realChildProcess,
  spawn: (file: string, args: string[], options: unknown) => {
    if (!isOurTail(args)) {
      return realSpawn(file, args, options);
    }
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
    // Stands in for an upstream middleware that drains the request body
    // before handing off; the body then ends while the handler is running.
    if (req.headers["x-test-drain-body"]) {
      req.on("close", () => (drainedRequestClosed = true));
      req.resume();
    }
    void middleware(req, res, async () => {
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  interceptBootedList = false;
  holdBootedList = null;
  rmSync(stateFile, { force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function openAppState(headers: Record<string, string> = {}) {
  return request({ host: "127.0.0.1", port, path: `/appstate?device=${DEVICE}`, headers });
}

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

describe("GET /appstate log stream lifecycle", () => {
  test("a connected client gets one SpringBoard tail, killed when it disconnects", async () => {
    tails.length = 0;
    const req = openAppState();
    const firstChunk = new Promise<string>((resolve, reject) => {
      req.on("response", (res) => res.once("data", (d) => resolve(String(d))));
      req.on("error", reject);
    });
    req.end();
    expect(await firstChunk).toBe(":\n\n");
    expect(await waitFor(() => tails.length === 1, 5_000)).toBe(true);
    expect(tails[0]!.killed).toBe(false);

    req.destroy();
    expect(await waitFor(() => tails[0]!.killed, 2_000)).toBe(true);
    expect(tails).toHaveLength(1);
  }, 10_000);

  test("a client that leaves during the bootstrap leaves no tail running", async () => {
    tails.length = 0;
    let release!: () => void;
    holdBootedList = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (bootedListReached = resolve));
    try {
      const req = openAppState();
      req.on("error", () => {});
      req.end();
      await reached; // the handler is mid-bootstrap
      req.destroy();
      await new Promise((r) => setTimeout(r, 100)); // let the server see the close
      release();
      // Unfixed, the tail is spawned ~150 ms later (after the frontmost
      // probe fails) and nothing ever kills it.
      await waitFor(() => tails.length > 0, 1_500);
      expect(tails.filter((tail) => !tail.killed)).toHaveLength(0);
    } finally {
      holdBootedList = null;
      release?.();
    }
  }, 10_000);

  test("a request whose body was drained upstream still gets a live tail", async () => {
    // A request emits 'close' once its body has been consumed, while the
    // client is still connected; only the response's 'close' means it left.
    tails.length = 0;
    drainedRequestClosed = false;
    let release!: () => void;
    holdBootedList = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (bootedListReached = resolve));
    const req = openAppState({ "x-test-drain-body": "1" });
    let body = "";
    req.on("response", (res) => res.on("data", (d) => (body += String(d))));
    req.on("error", () => {});
    req.end();
    try {
      await reached; // the handler is mid-bootstrap
      expect(await waitFor(() => drainedRequestClosed, 2_000)).toBe(true);
      release();
      expect(await waitFor(() => tails.length === 1, 5_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(tails[0]!.killed).toBe(false);
      tails[0]!.stdout.write(foregroundLine("com.example.drained", 21));
      expect(await waitFor(() => body.includes("com.example.drained"), 3_000)).toBe(true);
    } finally {
      holdBootedList = null;
      release?.();
      req.destroy();
    }
    expect(await waitFor(() => tails[0]?.killed === true, 2_000)).toBe(true);
  }, 10_000);

  test("forwards each user-facing foreground app once, across chunk boundaries", async () => {
    tails.length = 0;
    const req = openAppState();
    let body = "";
    req.on("response", (res) => res.on("data", (d) => (body += String(d))));
    req.on("error", () => {});
    req.end();
    try {
      expect(await waitFor(() => tails.length === 1, 5_000)).toBe(true);
      const feed = [
        foregroundLine("com.example.one", 11),
        foregroundLine("com.apple.WidgetRenderer.Extension", 12), // not a user-facing app
        foregroundLine("com.example.one", 13), // already reported
        "not json\n",
        foregroundLine("com.example.two", 14),
      ].join("");
      // Split mid-line, so a line must be reassembled before it is parsed.
      const cut = feed.indexOf("com.example.two") + 4;
      tails[0]!.stdout.write(feed.slice(0, cut));
      await new Promise((r) => setTimeout(r, 30));
      tails[0]!.stdout.write(feed.slice(cut));
      const events = () => body.split("\n\n").filter((e) => e.startsWith("data: ")).map((e) => JSON.parse(e.slice(6)));
      expect(await waitFor(() => events().length >= 2, 3_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(events()).toEqual([
        { bundleId: "com.example.one", pid: 11, isReactNative: false },
        { bundleId: "com.example.two", pid: 14, isReactNative: false },
      ]);
    } finally {
      req.destroy();
    }
    expect(await waitFor(() => tails[0]!.killed, 2_000)).toBe(true);
  }, 10_000);
});
