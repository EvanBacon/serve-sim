import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import {
  createForegroundTrackerCache,
  isUserFacingBundle,
  parseForegroundAppLogMessage,
  type ForegroundApp,
} from "../foreground-tracker";

// A fake `log stream` child: an EventEmitter with a writable-looking stdout, driven by emitting
// `data` chunks. Lets the tracker run without a booted simulator.
function fakeChild() {
  const stdout = Object.assign(new EventEmitter(), { destroy() {} });
  return Object.assign(new EventEmitter(), {
    stdout,
    killed: false,
    kill() {
      this.killed = true;
      return true;
    },
  });
}

function logChunk(bundleId: string, pid: number): Buffer {
  const eventMessage = `[app<${bundleId}>:${pid}] Setting process visibility to: Foreground`;
  return Buffer.from(JSON.stringify({ eventMessage }) + "\n");
}

function trackerWithFakeStream(restartDelayMs = 1000) {
  const children: ReturnType<typeof fakeChild>[] = [];
  const cache = createForegroundTrackerCache({
    spawnLogStream: () => {
      const child = fakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    frontmostApp: async () => null, // no AX seed in tests; drive foreground purely from the feed
    restartDelayMs,
  });
  return { cache, children };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("parseForegroundAppLogMessage", () => {
  test("extracts the bundle id and pid from a foreground line", () => {
    expect(
      parseForegroundAppLogMessage(
        "[app<com.apple.mobilesafari>:43117] Setting process visibility to: Foreground",
      ),
    ).toEqual({ bundleId: "com.apple.mobilesafari", pid: 43117 });
  });

  test("returns null for non-foreground lines", () => {
    expect(parseForegroundAppLogMessage("Setting process visibility to: Background")).toBeNull();
  });
});

describe("isUserFacingBundle", () => {
  test("keeps regular apps, drops widgets/extensions/services", () => {
    expect(isUserFacingBundle("com.apple.mobilesafari")).toBe(true);
    expect(isUserFacingBundle("dev.expo.MyApp")).toBe(true);
    expect(isUserFacingBundle("com.apple.WidgetRenderer")).toBe(false);
    expect(isUserFacingBundle("dev.expo.MyApp.extension")).toBe(false);
    // Generic names only match as whole components, so real apps that merely contain them stay in.
    expect(isUserFacingBundle("com.example.CustomerService")).toBe(true);
    expect(isUserFacingBundle("com.acme.InCallUITest")).toBe(true);
    expect(isUserFacingBundle("com.apple.foo.Service")).toBe(false);
  });
});

describe("createForegroundTrackerCache", () => {
  test("tracks the latest user-facing app from the log feed", () => {
    const { cache, children } = trackerWithFakeStream();
    const seen: ForegroundApp[] = [];
    const sub = cache.subscribe("UDID", (app) => seen.push(app));

    children[0]!.stdout.emit("data", logChunk("dev.expo.A", 11));

    expect(cache.peek("UDID")).toEqual({ bundleId: "dev.expo.A", pid: 11 });
    expect(seen).toEqual([{ bundleId: "dev.expo.A", pid: 11 }]);
    sub.unsubscribe();
  });

  test("ignores non-user-facing bundles and exact repeats, but tracks a same-bundle relaunch", () => {
    const { cache, children } = trackerWithFakeStream();
    const seen: ForegroundApp[] = [];
    const sub = cache.subscribe("UDID", (app) => seen.push(app));
    const child = children[0]!;

    child.stdout.emit("data", logChunk("dev.expo.A", 11));
    child.stdout.emit("data", logChunk("dev.expo.A", 11)); // exact repeat -> ignored
    child.stdout.emit("data", logChunk("com.apple.WidgetRenderer", 99)); // non-UI -> ignored
    child.stdout.emit("data", logChunk("dev.expo.A", 12)); // same bundle, new pid (relaunch) -> tracked
    child.stdout.emit("data", logChunk("dev.expo.B", 22));

    expect(seen).toEqual([
      { bundleId: "dev.expo.A", pid: 11 },
      { bundleId: "dev.expo.A", pid: 12 },
      { bundleId: "dev.expo.B", pid: 22 },
    ]);
    sub.unsubscribe();
  });

  test("respawns the log stream when it exits while subscribers remain", async () => {
    const { cache, children } = trackerWithFakeStream(0);
    const sub = cache.subscribe("UDID");
    expect(children).toHaveLength(1);

    children[0]!.emit("exit"); // the stream died unexpectedly
    await tick();
    expect(children).toHaveLength(2); // respawned so tracking recovers
    sub.unsubscribe();
  });

  test("does not respawn after an intentional stop", async () => {
    const { cache, children } = trackerWithFakeStream(0);
    const sub = cache.subscribe("UDID");
    sub.unsubscribe(); // last listener -> stop()

    children[0]!.emit("exit");
    await tick();
    expect(children).toHaveLength(1); // no respawn once stopped
  });

  test("ref-counts duplicate callbacks independently", () => {
    const { cache, children } = trackerWithFakeStream();
    const callback = () => {};
    const a = cache.subscribe("UDID", callback);
    const b = cache.subscribe("UDID", callback); // same reference
    expect(children).toHaveLength(1);

    a.unsubscribe();
    expect(children[0]!.killed).toBe(false); // b still active despite the shared callback
    b.unsubscribe();
    expect(children[0]!.killed).toBe(true);
  });

  test("shares one log stream per udid and stops it on last unsubscribe", () => {
    const { cache, children } = trackerWithFakeStream();
    const a = cache.subscribe("UDID");
    const b = cache.subscribe("UDID");
    expect(children).toHaveLength(1); // one shared tail

    a.unsubscribe();
    expect(children[0]!.killed).toBe(false); // still alive for b
    b.unsubscribe();
    expect(children[0]!.killed).toBe(true); // stopped with the last subscriber
    expect(cache.peek("UDID")).toBeNull(); // evicted
  });
});
