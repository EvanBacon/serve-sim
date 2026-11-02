import { expect, spyOn, test } from "bun:test";
import type { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DuoStateMonitor, parseHingeSample, parseIntegratedScreenOrientations, parsePrimaryPanel, type DuoState } from "../duo-state";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

/** A monitor whose processes are fakes; `hingeReader()` is the guest reader, if started. */
function fakeMonitor(duoHelper: () => string) {
  const spawned: { args: string[]; child: FakeChild }[] = [];
  const states: DuoState[] = [];
  const fakeSpawn = ((_command: string, args: string[]) => {
    const child = new FakeChild();
    spawned.push({ args, child });
    return child;
  }) as unknown as typeof spawn;
  // Never calls back: orientation and panel seeding stay idle.
  const fakeExecFile = (() => new FakeChild()) as unknown as typeof execFile;
  const monitor = new DuoStateMonitor("UDID", (state) => states.push(state), { duoHelper, spawn: fakeSpawn, execFile: fakeExecFile });
  const hingeReader = () => spawned.find(({ args }) => args.at(-1) === "watch-angle")?.child;
  return { monitor, states, spawned, hingeReader };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("primary panel readback follows guest hysteresis rather than angle", () => {
  expect(parsePrimaryPanel("[DisplayContentMode] COMPLETED: .cover:pri .inner:aux | 130.0°")).toBe("cover");
  expect(parsePrimaryPanel("[DisplayContentMode] COMPLETED: .cover:aux .inner:pri | 100.0°")).toBe("inner");
  expect(parsePrimaryPanel("[DisplayContentMode] .cover:off .inner:off")).toBeNull();
  expect(parsePrimaryPanel("unrelated .cover:pri")).toBeNull();
  expect(parsePrimaryPanel('Filtering the log data using "category == DisplayContentMode AND (eventMessage CONTAINS .cover:pri OR eventMessage CONTAINS .inner:pri)"')).toBeNull();
  expect(parsePrimaryPanel('[com.apple.log:] log stream --predicate category == DisplayContentMode .cover:pri')).toBeNull();
});

test("hinge samples are the guest reader's angle lines", () => {
  expect(parseHingeSample("angle 130.0")).toBe(130);
  expect(parseHingeSample("angle 128.6\r")).toBe(128.6);
  expect(parseHingeSample("angle 0.0")).toBe(0);
  expect(parseHingeSample("angle 180")).toBe(180);
});

test("hinge samples reject invalid, non-finite, and out-of-range readings", () => {
  for (const line of [
    "angle 181.0", "angle -1.0", "angle NaN", "angle inf", "angle", "angle 1e2", "angle 130.0 extra",
    "Hinge angle unavailable: CMAngleManager reports no hinge",
    // The devicectl format this reader replaced.
    "• +0.1s : Angle:130.0° Mech:130.0° AngleValid:Y",
  ]) {
    expect(parseHingeSample(line)).toBeNull();
  }
});

test("hinge angles from the guest reader reach the session state", async () => {
  const { monitor, states, hingeReader } = fakeMonitor(() => "/helper");
  const reader = hingeReader()!;
  expect(reader).toBeDefined();

  reader.stdout.write("angle 13");
  reader.stdout.write("0.0\nangle 130.0\n"); // split across chunks; the repeat is not a change
  await flush();
  expect(states.map((state) => state.hingeDegrees)).toEqual([130]);

  reader.stdout.write("angle 0.0\n");
  await flush();
  expect(states.at(-1)?.hingeDegrees).toBe(0);

  monitor.close();
  expect(reader.killed).toBe(true);
});

test("a helper that cannot be resolved leaves the hinge unknown without failing the monitor", () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { monitor, spawned, hingeReader } = fakeMonitor(() => {
      throw new Error("serve-sim-native.node not found");
    });
    expect(hingeReader()).toBeUndefined();
    expect(spawned.length).toBe(1); // the panel watcher still runs
    expect(error).toHaveBeenCalledWith("[duo] Hinge reader unavailable: serve-sim-native.node not found");
    monitor.close();
  } finally {
    error.mockRestore();
  }
});

test("orientation comes only from named integrated panels", () => {
  const text = `Connected Screens:
    (3) LCD-1:
        Screen ID: 3
        Device Name: primary-1
        Screen Type: Integrated
        UI Orientation: Landscape Left
    (1) LCD:
        Screen ID: 1
        Device Name: primary
        Screen Type: Integrated
        UI Orientation: Portrait Upside Down
    (2) TVOut:
        Device Name: external-0
        Screen Type: TVOut
        UI Orientation: Landscape Right
Port:
    Class: Display`;
  expect(parseIntegratedScreenOrientations(text)).toEqual({
    cover: "portrait_upside_down", inner: "landscape_left",
  });
  expect(parseIntegratedScreenOrientations("UI Orientation: Portrait")).toEqual({});
});
