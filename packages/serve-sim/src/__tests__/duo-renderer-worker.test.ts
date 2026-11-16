import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  DuoRenderer,
  DuoRendererError,
  duoModelPath,
  resolveDuoModel,
  type DuoModelLookup,
  type DuoRendererDeps,
} from "../duo-renderer";

// The RealityKit worker's process lifecycle, with a fake child: how it is
// launched, and that a crash, spawn failure, or garbage on stdout reaches the
// pending render and `onFailure` (with exit code / signal / stderr) instead of
// leaving the 3D stream hanging until the 10s timeout.

class FakeWorker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = 0;
  kill() {
    this.killed++;
    return true;
  }
}

const DEVELOPER_DIR = "/Applications/Xcode-27.app/Contents/Developer";
const MODEL = duoModelPath(DEVELOPER_DIR);
const EXECUTABLE = "/opt/serve-sim/dist/simduo/serve-sim-duo-render";
const FOUND: DuoModelLookup = { developerDir: DEVELOPER_DIR, source: "DEVELOPER_DIR", modelPath: MODEL, exists: true };

let consoleError: ReturnType<typeof spyOn>;
beforeEach(() => {
  consoleError = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

function launch(overrides: DuoRendererDeps = {}) {
  const spawned: { command: string; args: string[]; options: unknown; child: FakeWorker }[] = [];
  const failures: DuoRendererError[] = [];
  const deps: DuoRendererDeps = {
    executable: () => EXECUTABLE,
    resolveModel: () => FOUND,
    spawn: (command, args, options) => {
      const child = new FakeWorker();
      spawned.push({ command, args, options, child });
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    ...overrides,
  };
  const renderer = new DuoRenderer((error) => failures.push(error), deps);
  return { renderer, failures, spawned, worker: spawned[0]?.child };
}

/** The bytes the worker writes back: [u32 header length][header JSON][jpeg]. */
function workerFrame(jpeg: Buffer, projection: Record<string, unknown>): Buffer {
  const header = Buffer.from(JSON.stringify({ jpegLength: jpeg.length, ...projection }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  return Buffer.concat([prefix, header, jpeg]);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("Duo renderer launch", () => {
  test("spawns the bundled worker with the selected Xcode's model and the inherited environment", () => {
    const { renderer, spawned } = launch();
    expect(spawned).toHaveLength(1);
    // No `env`: the worker inherits DEVELOPER_DIR and the rest of the host
    // environment rather than a sanitised copy.
    expect(spawned[0]).toMatchObject({ command: EXECUTABLE, args: [MODEL], options: { stdio: "pipe" } });
    expect(Object.keys(spawned[0]!.options as object)).toEqual(["stdio"]);
    expect(renderer.modelPath).toBe(MODEL);
    renderer.close();
  });

  test("DEVELOPER_DIR picks which Xcode's model the worker is pointed at", () => {
    const beta = "/Applications/Xcode-beta.app/Contents/Developer";
    const { renderer, spawned } = launch({
      resolveModel: () => resolveDuoModel({ DEVELOPER_DIR: beta }, () => {
        throw new Error("xcode-select must not run when DEVELOPER_DIR is set");
      }, () => true),
    });
    expect(spawned[0]!.args).toEqual([duoModelPath(beta)]);
    expect(spawned[0]!.args[0]!.startsWith("/Applications/Xcode-beta.app/Contents/SharedFrameworks/")).toBe(true);
    renderer.close();
  });

  test("setup failures throw a staged error before any process is started", () => {
    const cases: { deps: DuoRendererDeps; stage: string; details: Record<string, unknown> }[] = [
      { deps: { executable: () => null }, stage: "worker_missing", details: {} },
      {
        deps: { resolveModel: () => ({ developerDir: null, source: "xcode-select", modelPath: null, exists: false, error: "xcode-select: error: no developer tools" }) },
        stage: "developer_dir",
        details: { source: "xcode-select", error: "xcode-select: error: no developer tools" },
      },
      {
        deps: { resolveModel: () => ({ ...FOUND, exists: false }) },
        stage: "model_lookup",
        details: { model_path: MODEL, developer_dir: DEVELOPER_DIR, source: "DEVELOPER_DIR" },
      },
    ];
    for (const { deps, stage, details } of cases) {
      let spawns = 0;
      let thrown: unknown;
      try {
        launch({ ...deps, spawn: () => { spawns++; return new FakeWorker() as unknown as ChildProcessWithoutNullStreams; } });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DuoRendererError);
      expect((thrown as DuoRendererError).stage as string).toBe(stage);
      expect((thrown as DuoRendererError).details).toEqual(details);
      expect(spawns).toBe(0);
    }
  });
});

describe("Duo renderer protocol", () => {
  test("a render writes one length-prefixed request and resolves with the worker's frame", async () => {
    const { renderer, worker, failures } = launch();
    const written: Buffer[] = [];
    worker!.stdin.on("data", (chunk: Buffer) => written.push(chunk));

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const result = renderer.render(jpeg, "inner", 95, -10, true);
    await tick();
    const request = Buffer.concat(written);
    const headerLength = request.readUInt32BE(0);
    expect(JSON.parse(request.subarray(4, 4 + headerLength).toString())).toEqual({
      jpegLength: 4, panel: "inner", hingeDegrees: 95, rollDegrees: -10, fullResolution: true,
    });
    expect(request.subarray(4 + headerLength)).toEqual(jpeg);

    // Split across pipe chunks, as a real pipe may deliver it.
    const reply = workerFrame(Buffer.from("JPEG"), { width: 1500, height: 1350, panel: "inner", hingeDegrees: 95, pieces: [] });
    worker!.stdout.write(reply.subarray(0, 3));
    worker!.stdout.write(reply.subarray(3));
    const frame = await result;
    expect(frame.jpeg.toString()).toBe("JPEG");
    expect(frame.projection).toEqual({ width: 1500, height: 1350, panel: "inner", hingeDegrees: 95, pieces: [] });
    expect(failures).toEqual([]);
    renderer.close();
  });

  test("only one render may be in flight", async () => {
    const { renderer } = launch();
    const first = renderer.render(Buffer.from([1]), "cover", 0, 0);
    await expect(renderer.render(Buffer.from([2]), "cover", 0, 0)).rejects.toThrow("Duo renderer is unavailable or busy");
    renderer.close();
    await expect(first).rejects.toThrow("Duo renderer closed");
  });

  test("a malformed frame header fails the render at the protocol stage", async () => {
    const { renderer, worker, failures } = launch();
    const result = renderer.render(Buffer.from([1]), "cover", 0, 0);
    const bogus = Buffer.alloc(4);
    bogus.writeUInt32BE(0); // zero-length header
    worker!.stdout.write(bogus);
    const error = await result.then(() => null, (e: unknown) => e) as DuoRendererError;
    expect(error).toBeInstanceOf(DuoRendererError);
    expect(error.stage).toBe("protocol");
    expect(error.reason).toBe("Duo renderer sent a malformed frame: Invalid Duo render header");
    expect(error.details).toEqual({ model_path: MODEL });
    expect(failures).toEqual([error]);
    expect(worker!.killed).toBe(1);
  });
});

describe("Duo renderer worker failures", () => {
  test("a crash mid-render rejects the render at once with signal and stderr tail", async () => {
    const { renderer, worker, failures } = launch();
    const result = renderer.render(Buffer.from([1]), "cover", 180, 0);
    worker!.stderr.write("RealityKit: assertion failed\n");
    await tick();
    worker!.emit("exit", null, "SIGTRAP");
    const error = await result.then(() => null, (e: unknown) => e) as DuoRendererError;
    expect(error.stage).toBe("worker_exit");
    expect(error.reason).toBe("Duo renderer exited");
    expect(error.details).toEqual({
      model_path: MODEL, exit_code: null, signal: "SIGTRAP", stderr_tail: "RealityKit: assertion failed",
    });
    expect(failures).toEqual([error]);
    expect(worker!.stdin.writableEnded).toBe(true);
    expect(worker!.killed).toBe(1);
    // The worker's stderr is echoed to the server log.
    expect(consoleError).toHaveBeenCalledWith("[duo-renderer]", "RealityKit: assertion failed");
    // A dead renderer refuses new work instead of queueing it forever.
    await expect(renderer.render(Buffer.from([2]), "cover", 0, 0)).rejects.toThrow("unavailable or busy");
  });

  test("an idle exit with a code reports it once, even if the process emits more events", () => {
    const { worker, failures } = launch();
    worker!.emit("exit", 133, null);
    worker!.emit("error", Object.assign(new Error("late"), { code: "EPIPE" }));
    worker!.emit("exit", 133, null);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.stage).toBe("worker_exit");
    expect(failures[0]!.details).toEqual({ model_path: MODEL, exit_code: 133, signal: null });
  });

  test("a spawn failure is a worker_spawn error naming the executable and errno code", async () => {
    const { renderer, worker, failures } = launch();
    const result = renderer.render(Buffer.from([1]), "cover", 0, 0);
    worker!.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    const error = await result.then(() => null, (e: unknown) => e) as DuoRendererError;
    expect(error.stage).toBe("worker_spawn");
    expect(error.reason).toBe("Duo renderer could not start: spawn EACCES");
    expect(error.details).toEqual({ executable: EXECUTABLE, code: "EACCES", model_path: MODEL });
    expect(failures).toEqual([error]);
  });

  test("a broken stdin pipe is reported as the worker going away", () => {
    const { worker, failures } = launch();
    worker!.stdin.emit("error", new Error("write EPIPE"));
    expect(failures).toHaveLength(1);
    expect(failures[0]!.stage).toBe("worker_exit");
    expect(failures[0]!.reason).toBe("Duo renderer input closed: write EPIPE");
  });

  test("close() rejects the pending render and later exit events are not failures", async () => {
    const { renderer, worker, failures } = launch();
    const result = renderer.render(Buffer.from([1]), "cover", 0, 0);
    renderer.close();
    renderer.close();
    await expect(result).rejects.toThrow("Duo renderer closed");
    worker!.emit("exit", null, "SIGTERM");
    expect(failures).toEqual([]);
    expect(worker!.killed).toBe(1);
  });
});
