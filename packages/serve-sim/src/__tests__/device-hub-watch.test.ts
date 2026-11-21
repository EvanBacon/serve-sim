import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DeviceHubInputWatcher, parseNotifyState } from "../device-hub-watch";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: () => void; killed: boolean };
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

describe("parseNotifyState", () => {
  test("parses state lines only", () => {
    expect(parseNotifyState("state 1")).toBe(1);
    expect(parseNotifyState("state 0\n")).toBe(0);
    expect(parseNotifyState("angle 3")).toBeNull();
    expect(parseNotifyState("state -1")).toBeNull();
    expect(parseNotifyState("")).toBeNull();
  });
});

describe("DeviceHubInputWatcher", () => {
  test("streams readings, reports unknown on exit, and restarts", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const calls: string[][] = [];
    const readings: (boolean | null)[] = [];
    const watcher = new DeviceHubInputWatcher("UDID", {
      helper: () => "/helper",
      onReading: (r) => readings.push(r),
      retryMs: 5,
      spawn: ((_cmd: string, args: string[]) => { calls.push(args); const c = fakeChild(); children.push(c); return c; }) as never,
    });
    expect(calls[0]!.slice(-4)).toEqual(["UDID", "/helper", "watch-notify", "com.apple.coredevice.dtuhidd.active"]);
    children[0]!.stdout.write("state 0\nstate 1\n");
    children[0]!.stdout.write("sta");
    children[0]!.stdout.write("te 0\n");
    await new Promise((r) => setTimeout(r, 1));
    expect(readings).toEqual([false, true, false]);
    children[0]!.emit("close", 0, null);
    expect(readings.at(-1)).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(children.length).toBe(2);
    watcher.close();
    expect(children[1]!.killed).toBe(true);
    children[1]!.emit("close", null, "SIGTERM");
    await new Promise((r) => setTimeout(r, 20));
    expect(children.length).toBe(2);
  });

  test("a watch that never produced a reading does not report unknown", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const readings: (boolean | null)[] = [];
    const watcher = new DeviceHubInputWatcher("UDID", {
      helper: () => "/helper",
      onReading: (r) => readings.push(r),
      retryMs: 1000,
      spawn: (() => { const c = fakeChild(); children.push(c); return c; }) as never,
    });
    children[0]!.emit("close", 1, null);
    expect(readings).toEqual([]);
    watcher.close();
  });

  test("a helper that cannot be resolved disables the watch", () => {
    let spawned = 0;
    const watcher = new DeviceHubInputWatcher("UDID", {
      helper: () => { throw new Error("missing"); },
      onReading: () => {},
      spawn: (() => { spawned++; return fakeChild(); }) as never,
    });
    expect(spawned).toBe(0);
    watcher.close();
  });
});
