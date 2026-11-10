import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import {
  CONTROL_DIR_ENV,
  FRAME_JSON,
  FRAME_STDOUT,
  FrameDecoder,
  controlFingerprint,
  controlMode,
  controlPaths,
  encodeFrame,
  encodeJson,
  fingerprintMismatch,
  isDispatchable,
  isStaleBuild,
  parseIdleMs,
  parseJsonFrame,
  type ControlMessage,
} from "../control-protocol";
import { adoptCaller } from "../control-worker";

// ─── Pure pieces ─────────────────────────────────────────────────────────

describe("isDispatchable", () => {
  test("short commands and root info flags dispatch", () => {
    expect(isDispatchable(["tap", "0.5", "0.5"])).toBe(true);
    expect(isDispatchable(["button", "home", "-d", "X"])).toBe(true);
    expect(isDispatchable(["buffer", "status"])).toBe(true);
    expect(isDispatchable(["--help"])).toBe(true);
    expect(isDispatchable(["-v"])).toBe(true);
    expect(isDispatchable(["help", "tap"])).toBe(true);
  });

  test("servers, long-running, stdin and unknown commands stay in-process", () => {
    expect(isDispatchable([])).toBe(false);
    expect(isDispatchable(["--port", "3412"])).toBe(false);
    expect(isDispatchable(["--detach"])).toBe(false);
    expect(isDispatchable(["record"])).toBe(false);
    expect(isDispatchable(["camera", "status"])).toBe(false);
    expect(isDispatchable(["exec", "ls"])).toBe(false);
    expect(isDispatchable(["control", "status"])).toBe(false);
    expect(isDispatchable(["type", "--stdin"])).toBe(false);
    expect(isDispatchable(["paste", "--stdin", "-d", "X"])).toBe(false);
    expect(isDispatchable(["iPhone 16"])).toBe(false);
    expect(isDispatchable(["--help", "tap"])).toBe(false);
  });
});

describe("controlMode", () => {
  test("defaults to auto, off/on overrides, CI only reuses", () => {
    expect(controlMode({})).toBe("auto");
    expect(controlMode({ SERVE_SIM_CONTROL: "0" })).toBe("off");
    expect(controlMode({ SERVE_SIM_CONTROL: "off" })).toBe("off");
    expect(controlMode({ CI: "true" })).toBe("use");
    expect(controlMode({ CI: "false" })).toBe("auto");
    expect(controlMode({ CI: "1", SERVE_SIM_CONTROL: "1" })).toBe("auto");
  });

  test("parseIdleMs falls back on junk", () => {
    expect(parseIdleMs(undefined)).toBe(300_000);
    expect(parseIdleMs("2000")).toBe(2000);
    expect(parseIdleMs("nope")).toBe(300_000);
    expect(parseIdleMs("5")).toBe(300_000);
  });
});

describe("framing", () => {
  test("decodes frames split across arbitrary chunks", () => {
    const wire = Buffer.concat([
      encodeJson({ t: "accepted" }),
      encodeFrame(FRAME_STDOUT, "hello\n"),
      encodeJson({ t: "exit", code: 3, signal: null }),
    ]);
    const decoder = new FrameDecoder();
    const frames = [];
    for (let i = 0; i < wire.length; i += 3) frames.push(...decoder.push(wire.subarray(i, i + 3)));
    expect(frames.map((f) => f.type)).toEqual([FRAME_JSON, FRAME_STDOUT, FRAME_JSON]);
    expect(frames[1]!.payload.toString()).toBe("hello\n");
    expect(parseJsonFrame(frames[2]!)).toEqual({ t: "exit", code: 3, signal: null });
  });

  test("rejects oversized frames and ignores non-JSON", () => {
    const header = Buffer.alloc(5);
    header.writeUInt8(FRAME_JSON, 0);
    header.writeUInt32BE(0xffffffff, 1);
    expect(() => new FrameDecoder().push(header)).toThrow(/too large/);
    expect(parseJsonFrame({ type: FRAME_JSON, payload: Buffer.from("{nope") })).toBeNull();
  });
});

describe("fingerprint", () => {
  const base = {
    protocol: 1,
    execPath: "/n",
    home: "/h",
    tmpdir: "/t",
    debug: "",
    binMtimeMs: 1,
    mainMtimeMs: 2,
  };
  test("reports the first differing field; rebuilds are stale", () => {
    expect(fingerprintMismatch(base, { ...base })).toBeNull();
    expect(fingerprintMismatch(base, { ...base, debug: "serve-sim*" })).toBe("debug");
    expect(isStaleBuild(fingerprintMismatch(base, { ...base, mainMtimeMs: 3 }))).toBe(true);
    expect(isStaleBuild("home")).toBe(false);
  });

  test("socket paths are per install and node binary", () => {
    const env = { HOME: "/h", [CONTROL_DIR_ENV]: "/tmp/x" };
    const a = controlPaths({ binFile: "/a/serve-sim.js", execPath: "/n", env });
    const b = controlPaths({ binFile: "/b/serve-sim.js", execPath: "/n", env });
    const c = controlPaths({ binFile: "/a/serve-sim.js", execPath: "/n2", env });
    expect(a.socket.startsWith("/tmp/x/control-")).toBe(true);
    expect(new Set([a.socket, b.socket, c.socket]).size).toBe(3);
    expect(controlFingerprint({ binFile: "/missing", mainFile: "/missing", execPath: "/n", env }).mainMtimeMs).toBe(-1);
  });
});

describe("adoptCaller", () => {
  test("takes over argv, env, cwd and TTY shape", () => {
    const dir = mkdtempSync("/tmp/ssctl-adopt-");
    const chdirs: string[] = [];
    const stdout = {} as NodeJS.WriteStream;
    const proc = {
      argv: ["/node", "/bin.js"],
      env: { KEEP: "old", DROP: "x" } as NodeJS.ProcessEnv,
      chdir: (d: string) => chdirs.push(d),
      stdout,
      stderr: {} as NodeJS.WriteStream,
    } as unknown as NodeJS.Process;
    adoptCaller(
      {
        t: "run",
        fingerprint: {} as never,
        argv: ["tap", "1", "2"],
        cwd: dir,
        env: { KEEP: "new", ADD: "y" },
        tty: { stdout: { isTTY: true, columns: 120 }, stderr: { isTTY: false } },
      },
      proc,
    );
    expect(proc.argv).toEqual(["/node", "/bin.js", "tap", "1", "2"]);
    expect(proc.env).toEqual({ KEEP: "new", ADD: "y" });
    expect(chdirs).toEqual([dir]);
    expect(stdout.isTTY).toBe(true);
    expect(stdout.columns).toBe(120);
    expect(proc.stderr.isTTY).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── Real processes ──────────────────────────────────────────────────────
// Build the real bin next to a fake CLI bundle and drive it with node, the
// runtime the published bin targets.

const NODE = spawnSync("node", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" });
const nodePath = NODE.status === 0 ? NODE.stdout : null;
const describeWithNode = nodePath ? describe : describe.skip;

describeWithNode("control process", () => {
  let root: string;
  let dist: string;
  let binFile: string;
  let mainFile: string;
  let ctlDir: string;
  let work: string;
  const stray: ChildProcess[] = [];

  beforeAll(async () => {
    // realpath: macOS /tmp is a symlink, and the bin keys its socket on its own real path.
    root = realpathSync(mkdtempSync("/tmp/ssctl-"));
    dist = join(root, "dist");
    for (const [entry, naming] of [
      [join(import.meta.dir, "../bin.ts"), "serve-sim.js"],
      [join(import.meta.dir, "fixtures/control-fake-cli.ts"), "serve-sim-cli.js"],
    ] as const) {
      const result = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", outdir: dist, naming });
      if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    }
    binFile = join(dist, "serve-sim.js");
    mainFile = join(dist, "serve-sim-cli.js");
  });

  beforeEach(() => {
    ctlDir = mkdtempSync(join(root, "c"));
    work = mkdtempSync(join(root, "w"));
  });

  afterEach(async () => {
    await cli(["control", "stop"]);
    for (const c of stray.splice(0)) c.kill("SIGKILL");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = { ...process.env, [CONTROL_DIR_ENV]: ctlDir, SERVE_SIM_CONTROL_IDLE_MS: "60000" };
    delete e.CI;
    delete e.SERVE_SIM_CONTROL;
    delete e.EXIT_CODE;
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete e[k];
      else e[k] = v;
    }
    return e;
  }

  function cli(
    args: string[],
    opts: { env?: Record<string, string | undefined>; cwd?: string } = {},
  ): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(nodePath!, [binFile, ...args], { cwd: opts.cwd ?? work, env: env(opts.env) });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  }

  async function status(): Promise<{ running: boolean; pid?: number; served?: number; warm?: number; busy?: number }> {
    const r = await cli(["control", "status", "--json"]);
    return JSON.parse(r.stdout);
  }

  async function until<T>(probe: () => Promise<T | null | false>, ms = 5000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await probe();
      if (v) return v;
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await Bun.sleep(25);
    }
  }

  const warm = () => until(async () => ((await status()).warm ?? 0) >= 1);

  async function startDaemon() {
    const r = await cli(["control", "start", "--json"]);
    expect(r.code).toBe(0);
    await warm();
    return JSON.parse(r.stdout) as { pid: number; alreadyRunning: boolean };
  }

  test("start is idempotent and status/stop report it", async () => {
    expect((await cli(["control", "status"])).code).toBe(1);
    const first = await startDaemon();
    expect(first.alreadyRunning).toBe(false);
    const again = JSON.parse((await cli(["control", "start", "--json"])).stdout);
    expect(again).toMatchObject({ alreadyRunning: true, pid: first.pid });
    const stop = JSON.parse((await cli(["control", "stop", "--json"])).stdout);
    expect(stop).toMatchObject({ wasRunning: true, pid: first.pid });
    expect((await status()).running).toBe(false);
    expect(JSON.parse((await cli(["control", "stop", "--json"])).stdout)).toMatchObject({ wasRunning: false });
    const paths = controlPaths({ binFile, execPath: nodePath!, env: env() });
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  test("dispatches a command with the caller's argv, cwd, env, output and exit code", async () => {
    const daemon = await startDaemon();
    const sub = join(work, "sub dir");
    mkdirSync(sub);
    const r = await cli(["tap", "0.25", "0.75"], { cwd: sub, env: { FOO: "bar", EXIT_CODE: "3" } });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe("to stderr\n");
    const seen = JSON.parse(r.stdout);
    expect(seen).toMatchObject({
      argv: ["tap", "0.25", "0.75"],
      argv1: binFile,
      cwd: sub,
      foo: "bar",
      role: null,
      stdoutIsTTY: false,
    });
    // It ran in one of the daemon's workers, not in the client.
    expect(seen.ppid).toBe(daemon.pid);
    expect((await status()).served).toBe(1);
  });

  test("process.exit codes, thrown errors and help/version come back intact", async () => {
    await startDaemon();
    expect(await cli(["button", "9"])).toMatchObject({ code: 9, stdout: "exiting hard\n" });
    const thrown = await cli(["ax"]);
    expect(thrown.code).toBe(1);
    expect(thrown.stderr).toContain("boom from ax");
    expect(await cli(["--version"])).toMatchObject({ code: 0, stdout: "fake 1.0.0\n", stderr: "" });
    expect((await status()).served).toBe(3);
  });

  test("reuses the daemon with a fresh worker per call", async () => {
    const daemon = await startDaemon();
    const a = JSON.parse((await cli(["tap", "1", "1"])).stdout);
    const b = JSON.parse((await cli(["tap", "2", "2"])).stdout);
    expect(a.ppid).toBe(daemon.pid);
    expect(b.ppid).toBe(daemon.pid);
    expect(a.pid).not.toBe(b.pid);
    expect((await status()).pid).toBe(daemon.pid);
  });

  test("auto-starts on first use; that call runs in-process", async () => {
    const first = await cli(["tap", "1", "1"]);
    expect(first.code).toBe(0);
    const firstSeen = JSON.parse(first.stdout);
    const s = await until(async () => {
      const v = await status();
      return v.running && (v.warm ?? 0) >= 1 ? v : null;
    });
    expect(firstSeen.ppid).not.toBe(s.pid);
    const second = JSON.parse((await cli(["tap", "1", "1"])).stdout);
    expect(second.ppid).toBe(s.pid);
  });

  test("never starts with SERVE_SIM_CONTROL=0 or under CI, and stays in-process for other commands", async () => {
    expect((await cli(["tap", "1", "1"], { env: { SERVE_SIM_CONTROL: "0" } })).code).toBe(0);
    expect((await cli(["tap", "1", "1"], { env: { CI: "true" } })).code).toBe(0);
    expect(await cli(["record"])).toMatchObject({ code: 0, stdout: "direct-only:record\n" });
    await Bun.sleep(300);
    expect((await status()).running).toBe(false);

    // CI reuses one that is already running.
    const daemon = await startDaemon();
    expect(JSON.parse((await cli(["tap", "1", "1"], { env: { CI: "true" } })).stdout).ppid).toBe(daemon.pid);
    expect(JSON.parse((await cli(["tap", "1", "1"], { env: { SERVE_SIM_CONTROL: "0" } })).stdout).ppid).not.toBe(daemon.pid);
  });

  test("recovers from a stale socket and pid file left by a killed daemon", async () => {
    const paths = controlPaths({ binFile, execPath: nodePath!, env: env() });
    // A listener that dies without cleanup leaves the socket file behind.
    const dead = spawn(nodePath!, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(paths.socket)}, () => process.kill(process.pid, "SIGKILL"))`,
    ]);
    await new Promise((r) => dead.on("close", r));
    expect(existsSync(paths.socket)).toBe(true);
    writeFileSync(paths.pidFile, JSON.stringify({ pid: dead.pid }));

    // The caller still gets its answer (in-process) and a new daemon takes over.
    const r = await cli(["tap", "1", "1"]);
    expect(r.code).toBe(0);
    const s = await until(async () => {
      const v = await status();
      return v.running && (v.warm ?? 0) >= 1 ? v : null;
    });
    expect(JSON.parse((await cli(["tap", "1", "1"])).stdout).ppid).toBe(s.pid);
  });

  test("stop clears stale files when nothing is listening", async () => {
    const paths = controlPaths({ binFile, execPath: nodePath!, env: env() });
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.socket, "");
    writeFileSync(paths.pidFile, JSON.stringify({ pid: 999_999 }));
    expect(JSON.parse((await cli(["control", "stop", "--json"])).stdout)).toMatchObject({
      wasRunning: false,
      clearedStale: true,
    });
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  test("exits on its own after the idle period and cleans up", async () => {
    const r = await cli(["control", "start", "--json"], { env: { SERVE_SIM_CONTROL_IDLE_MS: "400" } });
    const { pid } = JSON.parse(r.stdout);
    const paths = controlPaths({ binFile, execPath: nodePath!, env: env() });
    await until(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5000);
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.pidFile)).toBe(false);
    // No orphaned workers: none of them is still a child of the dead daemon.
    const ps = spawnSync("ps", ["-A", "-o", "ppid="], { encoding: "utf8" }).stdout;
    expect(ps.split("\n").map((l) => Number(l.trim()))).not.toContain(pid);
  });

  test("a rebuilt dist makes the daemon step aside", async () => {
    const daemon = await startDaemon();
    const later = new Date(Date.now() + 5000);
    utimesSync(mainFile, later, later);
    const r = JSON.parse((await cli(["tap", "1", "1"])).stdout);
    expect(r.ppid).not.toBe(daemon.pid);
    await until(async () => {
      try {
        process.kill(daemon.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  test("callers with a different HOME/DEBUG run in-process", async () => {
    const daemon = await startDaemon();
    const r = JSON.parse((await cli(["tap", "1", "1"], { env: { DEBUG: "serve-sim*" } })).stdout);
    expect(r.ppid).not.toBe(daemon.pid);
    expect((await status()).pid).toBe(daemon.pid);
  });

  test("forwards Ctrl+C to the worker", async () => {
    await startDaemon();
    const child = spawn(nodePath!, [binFile, "settle"], { cwd: work, env: env() });
    stray.push(child);
    let stdout = "";
    await new Promise<void>((resolve) =>
      child.stdout.on("data", (d) => {
        stdout += d;
        if (stdout.includes("waiting")) resolve();
      }),
    );
    child.kill("SIGINT");
    const code = await new Promise((r) => child.on("close", (c) => r(c)));
    expect(code).toBe(130);
    expect(stdout).toBe("waiting\ngot SIGINT\n");
  });

  test("a caller that dies mid-command takes its worker with it", async () => {
    await startDaemon();
    const child = spawn(nodePath!, [binFile, "settle"], { cwd: work, env: env() });
    await new Promise<void>((resolve) => child.stdout.on("data", () => resolve()));
    expect((await status()).busy).toBe(1);
    child.kill("SIGKILL");
    // The fake settle would otherwise run for 10s.
    await until(async () => (await status()).busy === 0, 3000);
  });

  test("concurrent starters share one daemon and concurrent calls all complete", async () => {
    const starts = await Promise.all(Array.from({ length: 4 }, () => cli(["control", "start", "--json"])));
    const pids = new Set(starts.map((s) => JSON.parse(s.stdout).pid));
    expect(pids.size).toBe(1);
    const [pid] = [...pids];

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => cli(["tap", String(i), "0"], { env: { EXIT_CODE: String(i % 3) } })),
    );
    results.forEach((r, i) => {
      expect(r.code).toBe(i % 3);
      const seen = JSON.parse(r.stdout);
      expect(seen.argv).toEqual(["tap", String(i), "0"]);
      expect(seen.ppid).toBe(pid);
    });
    expect(new Set(results.map((r) => JSON.parse(r.stdout).pid)).size).toBe(8);
    expect((await status()).served).toBe(8);
  });

  test("concurrent auto-starts converge on one daemon", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => cli(["tap", "1", "1"])));
    for (const r of results) expect(r.code).toBe(0);
    const s = await until(async () => {
      const v = await status();
      return v.running ? v : null;
    });
    await Bun.sleep(500);
    const daemons = spawnSync("pgrep", ["-f", `${binFile} __control-daemon`], { encoding: "utf8" })
      .stdout.split("\n")
      .filter(Boolean);
    expect(daemons).toEqual([String(s.pid)]);
  });

  test("rejects malformed and unknown first messages without wedging", async () => {
    await startDaemon();
    const paths = controlPaths({ binFile, execPath: nodePath!, env: env() });
    const { createConnection } = await import("net");
    await new Promise<void>((resolve) => {
      const c = createConnection(paths.socket);
      c.on("connect", () => c.write(encodeJson({ t: "accepted" } as ControlMessage)));
      c.on("close", () => resolve());
      c.on("error", () => resolve());
      c.resume();
    });
    expect((await cli(["--version"])).stdout).toBe("fake 1.0.0\n");
  });
});
