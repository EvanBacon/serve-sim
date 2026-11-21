import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DuoStateMonitor, type DuoState } from "../duo-state";
import { simctlArguments } from "../simctl";

// The Duo monitor's child processes: the guest hinge reader
// (`simctl spawn <udid> serve-sim-duo-hid watch-angle`), the SpringBoard panel
// log stream, and the `simctl io enumerate` orientation poll. When one of them
// dies the monitor must say why once, restart it, and stop for good on close.

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

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const RETRY_MS = 1000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// The monitor's restarts and polls are 1s timers. Capture those instead of
// waiting on them, so the tests are instant and deterministic; any other
// delay goes to the real timers.
type Captured = { fn: () => void; cleared: boolean; unref: () => Captured };
let captured: Captured[] = [];
let setTimeoutSpy: ReturnType<typeof spyOn>;
let clearTimeoutSpy: ReturnType<typeof spyOn>;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Fires every pending 1s timer once (like `RETRY_MS` elapsing). */
function elapseRetry(): void {
  const due = captured.splice(0);
  for (const timer of due) if (!timer.cleared) timer.fn();
}

let consoleError: ReturnType<typeof spyOn>;
beforeEach(() => {
  captured = [];
  consoleError = spyOn(console, "error").mockImplementation(() => {});
  setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== RETRY_MS) return realSetTimeout(fn, ms, ...rest);
    const timer: Captured = { fn, cleared: false, unref: () => timer };
    captured.push(timer);
    return timer;
  }) as unknown as typeof setTimeout);
  clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: unknown) => {
    const fake = captured.find((t) => t === timer);
    if (fake) fake.cleared = true;
    else realClearTimeout(timer as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout);
});
afterEach(() => {
  setTimeoutSpy.mockRestore();
  clearTimeoutSpy.mockRestore();
  consoleError.mockRestore();
});

function fakeMonitor(onFoldOverlay?: (phase: "start" | "postflight" | "reset") => void) {
  const spawned: { args: string[]; child: FakeChild }[] = [];
  const execs: { args: string[]; options: unknown; callback: ExecCallback; child: FakeChild }[] = [];
  const states: DuoState[] = [];
  const fakeSpawn = ((_command: string, args: string[]) => {
    const child = new FakeChild();
    spawned.push({ args, child });
    return child;
  }) as unknown as typeof spawn;
  const fakeExecFile = ((_command: string, args: string[], options: unknown, callback: ExecCallback) => {
    const child = new FakeChild();
    execs.push({ args, options, callback, child });
    return child;
  }) as unknown as typeof execFile;
  const monitor = new DuoStateMonitor("UDID", (state) => states.push({ ...state }), {
    duoHelper: () => "/cache/serve-sim-duo-hid",
    onFoldOverlay,
    spawn: fakeSpawn,
    execFile: fakeExecFile,
  });
  const readers = () => spawned.filter(({ args }) => args.at(-1) === "watch-angle").map(({ child }) => child);
  const panelStreams = () => spawned.filter(({ args }) => args.includes("stream")).map(({ child }) => child);
  const hingeLogs = () => consoleError.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.startsWith("[duo] Hinge reader stopped"));
  return { monitor, spawned, execs, states, readers, panelStreams, hingeLogs };
}

describe("Duo hinge reader exit reporting", () => {
  test("a reader that dies is reported with its stderr, then restarted with the same command", async () => {
    const { monitor, spawned, readers, hingeLogs } = fakeMonitor();
    const first = readers()[0]!;
    first.stderr.write("dyld[123]: DYLD_ROOT_PATH not set for simulator program\n");
    await flush();
    first.emit("close", 134, null);
    expect(hingeLogs()).toEqual([
      "[duo] Hinge reader stopped (dyld[123]: DYLD_ROOT_PATH not set for simulator program); retrying.",
    ]);
    expect(readers()).toHaveLength(1);

    elapseRetry();
    expect(readers()).toHaveLength(2);
    const restart = spawned.filter(({ args }) => args.at(-1) === "watch-angle");
    expect(restart[1]!.args).toEqual(restart[0]!.args);
    expect(restart[1]!.args).toEqual(simctlArguments(["spawn", "UDID", "/cache/serve-sim-duo-hid", "watch-angle"]));
    monitor.close();
  });

  test("without stderr the reason is the signal, else the exit code; only the first stop is logged", async () => {
    for (const [code, signal, reason] of [[null, "SIGKILL", "signal SIGKILL"], [1, null, "exit code 1"]] as const) {
      const { monitor, readers, hingeLogs } = fakeMonitor();
      readers()[0]!.emit("close", code, signal);
      expect(hingeLogs()).toEqual([`[duo] Hinge reader stopped (${reason}); retrying.`]);
      monitor.close();
      consoleError.mockClear();
    }

    // A reader that keeps crashing does not spam the log on every retry.
    const { monitor, readers, hingeLogs } = fakeMonitor();
    readers()[0]!.emit("close", 1, null);
    elapseRetry();
    readers()[1]!.emit("close", 1, null);
    expect(hingeLogs()).toHaveLength(1);
    monitor.close();
  });

  test("a spawn error does not throw; the close that follows drives the retry", () => {
    const { monitor, readers, hingeLogs } = fakeMonitor();
    const reader = readers()[0]!;
    expect(() => reader.emit("error", Object.assign(new Error("spawn xcrun ENOENT"), { code: "ENOENT" }))).not.toThrow();
    reader.emit("close", -2, null);
    expect(hingeLogs()).toEqual(["[duo] Hinge reader stopped (exit code -2); retrying."]);
    monitor.close();
  });

  test("the stderr kept for the report is bounded to its tail", async () => {
    const { monitor, readers, hingeLogs } = fakeMonitor();
    const reader = readers()[0]!;
    reader.stderr.write(`${"x".repeat(5000)}END`);
    await flush();
    reader.emit("close", 1, null);
    const [line] = hingeLogs();
    const reason = /\((.*)\); retrying\.$/.exec(line!)![1]!;
    expect(reason.length).toBe(1024);
    expect(reason.endsWith("END")).toBe(true);
    monitor.close();
  });

  test("closing the monitor stops a pending restart and a reader closing afterwards is not reported", async () => {
    const { monitor, readers, hingeLogs } = fakeMonitor();
    readers()[0]!.emit("close", 1, null);
    monitor.close();
    elapseRetry();
    expect(readers()).toHaveLength(1);
    expect(hingeLogs()).toHaveLength(1);
    consoleError.mockClear();

    const second = fakeMonitor();
    const reader = second.readers()[0]!;
    second.monitor.close();
    reader.emit("close", null, "SIGTERM");
    expect(second.hingeLogs()).toEqual([]);
    elapseRetry();
    expect(second.readers()).toHaveLength(1);
  });

  test("samples arriving after close are ignored", async () => {
    const { monitor, readers, states } = fakeMonitor();
    const reader = readers()[0]!;
    monitor.close();
    reader.stdout.write("angle 90.0\n");
    await flush();
    expect(states).toEqual([]);
  });
});

describe("Duo panel and orientation watchers", () => {
  test("the panel log stream restarts after it exits, and close kills every child", async () => {
    const { monitor, panelStreams, readers, execs } = fakeMonitor();
    const stream = panelStreams()[0]!;
    stream.emit("error", new Error("spawn failed"));
    stream.emit("close", 1, null);
    elapseRetry();
    expect(panelStreams()).toHaveLength(2);

    monitor.close();
    expect(panelStreams()[1]!.killed).toBe(true);
    expect(readers()[0]!.killed).toBe(true);
    expect(readers()[0]!.stdin.writableEnded).toBe(true);
    // The current `log show` seed (from the restart) and the pending
    // `io enumerate` poll are killed too.
    expect(execs.filter(({ args }) => args.includes("show")).at(-1)!.child.killed).toBe(true);
    expect(execs.find(({ args }) => args.includes("enumerate"))!.child.killed).toBe(true);
    panelStreams()[1]!.emit("close", null, "SIGTERM");
    elapseRetry();
    expect(panelStreams()).toHaveLength(2);
  });

  // Reproduced on a real iOS 27.2 simulator: `log show --last boot` takes
  // 1-3s there, longer than the 1s stream restart, so a stream that ends early
  // leaves two seeds running at once.
  test("close kills a `log show` seed that outlived a panel stream restart", () => {
    const shows = (execs: ReturnType<typeof fakeMonitor>["execs"]) => execs.filter(({ args }) => args.includes("show"));

    // The first seed finishes after the restart started a second one.
    const finished = fakeMonitor();
    finished.panelStreams()[0]!.emit("close", 0, null);
    elapseRetry();
    expect(shows(finished.execs)).toHaveLength(2);
    shows(finished.execs)[0]!.callback(null, "", "");
    finished.monitor.close();
    expect(shows(finished.execs)[1]!.child.killed).toBe(true);

    // Both seeds still running at close.
    const running = fakeMonitor();
    running.panelStreams()[0]!.emit("close", 0, null);
    elapseRetry();
    running.monitor.close();
    expect(shows(running.execs).map(({ child }) => child.killed)).toEqual([true, true]);
  });

  test("the boot log seeds the primary panel unless a live event already arrived", async () => {
    const seed = "x [DisplayContentMode] COMPLETED: .cover:aux .inner:pri | 100.0°\n";

    const seeded = fakeMonitor();
    const showSeeded = seeded.execs.find(({ args }) => args.includes("show"))!;
    // simctlArguments adds `--set <dir>` when SERVE_SIM_DEVICE_SET is configured.
    expect(showSeeded.args).toEqual([
      ...simctlArguments(["spawn", "UDID", "log", "show", "--last", "boot", "--style", "compact", "--predicate"]),
      expect.stringContaining('process == "SpringBoard"'),
    ]);
    showSeeded.callback(null, `x [DisplayContentMode] .cover:pri .inner:aux\n${seed}`, "");
    expect(seeded.states.at(-1)?.primaryPanel).toBe("inner"); // the most recent transition wins
    seeded.monitor.close();

    const live = fakeMonitor();
    live.panelStreams()[0]!.stdout.write("y [DisplayContentMode] COMPLETED: .cover:pri .inner:aux | 130.0°\n");
    await flush();
    expect(live.states.at(-1)?.primaryPanel).toBe("cover");
    live.execs.find(({ args }) => args.includes("show"))!.callback(null, seed, "");
    expect(live.states.at(-1)?.primaryPanel).toBe("cover"); // stale seed does not override live
    live.monitor.close();
  });

  test("orientation is read from `simctl io enumerate` and a failed read is not a state change", () => {
    const { monitor, execs, states } = fakeMonitor();
    const enumerate = execs.find(({ args }) => args.includes("enumerate"))!;
    expect(enumerate.args).toEqual(simctlArguments(["io", "UDID", "enumerate"]));
    expect(enumerate.options).toMatchObject({ timeout: 3000 });
    enumerate.callback(new Error("simctl timed out"), "", "");
    expect(states).toEqual([]);
    monitor.close();

    const ok = fakeMonitor();
    ok.execs.find(({ args }) => args.includes("enumerate"))!.callback(null, `
    (1) LCD:
        Device Name: primary
        Screen Type: Integrated
        UI Orientation: Landscape Right`, "");
    expect(ok.states).toEqual([{ orientations: { cover: "landscape_right" } }]);
    ok.monitor.close();
  });
});

describe("Duo fold overlay stream", () => {
  test("live fold-overlay lines reach onFoldOverlay without touching the panel state", async () => {
    const phases: string[] = [];
    const running = fakeMonitor((phase) => phases.push(phase));
    const stream = running.panelStreams()[0]!;
    expect(running.spawned.find(({ args }) => args.includes("stream"))!.args.at(-1)).toContain("ContinuousFoldSnapshotOverlay");
    const z = "x [com.apple.SpringBoard:ZStack] Requested update preferences for <ContinuousFoldSnapshotOverlay> with reason: ";
    stream.stdout.write(`${z}cloak installed\n${z}cloak reveal began\n${z}snapshot removed at postflight\n`);
    await flush();
    expect(phases).toEqual(["start", "postflight"]);
    expect(running.states.some((state) => state.primaryPanel)).toBe(false);
    // The boot-log seed keeps the narrower panel-only predicate.
    expect(running.execs.find(({ args }) => args.includes("show"))!.args.at(-1)).not.toContain("ZStack");
    running.monitor.close();
  });
});
