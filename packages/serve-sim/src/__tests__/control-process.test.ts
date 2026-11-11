import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
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
  nodeRuntimeOverride,
  parseAcceptMs,
  parseIdleMs,
  parseJsonFrame,
  unsafeControlDir,
  unsafeControlSocket,
  withoutNodeRuntimeEnv,
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
    expect(parseAcceptMs(undefined)).toBe(1000);
    expect(parseAcceptMs("30000")).toBe(30000);
    expect(parseAcceptMs("-1")).toBe(1000);
  });

  test("node runtime settings are stripped from workers and force in-process", () => {
    expect(withoutNodeRuntimeEnv({ NODE_OPTIONS: "--require x", NODE_EXTRA_CA_CERTS: "/ca", KEEP: "1" })).toEqual({
      KEEP: "1",
    });
    expect(nodeRuntimeOverride({}, [])).toBeNull();
    expect(nodeRuntimeOverride({ NODE_OPTIONS: "" }, [])).toBeNull();
    expect(nodeRuntimeOverride({ NODE_USE_ENV_PROXY: "1" }, [])).toBe("NODE_USE_ENV_PROXY");
    expect(nodeRuntimeOverride({}, ["--inspect"])).toBe("execArgv");
  });
});

describe("control dir and socket ownership", () => {
  test("default dir is per uid", () => {
    const p = controlPaths({ binFile: "/a", execPath: "/n", env: { HOME: "/h" } });
    expect(p.dir.endsWith(`serve-sim-control-${process.getuid!()}`)).toBe(true);
  });

  test("rejects missing, group/other-writable, symlinked and foreign-owned dirs", () => {
    const base = realpathSync(mkdtempSync("/tmp/ssctl-own-"));
    try {
      const ok = join(base, "ok");
      mkdirSync(ok, { mode: 0o700 });
      expect(unsafeControlDir(ok)).toBeNull();
      expect(unsafeControlDir(join(base, "nope"))).toBe("missing");
      const open = join(base, "open");
      mkdirSync(open);
      chmodSync(open, 0o777);
      expect(unsafeControlDir(open)).toMatch(/group\/other/);
      chmodSync(open, 0o750);
      expect(unsafeControlDir(open)).toMatch(/group\/other/);
      const link = join(base, "link");
      symlinkSync(ok, link);
      expect(unsafeControlDir(link)).toBe("symlink");
      const file = join(base, "file");
      writeFileSync(file, "");
      expect(unsafeControlDir(file)).toBe("not a directory");
      // Root-owned: stands in for a directory another user pre-created.
      if (process.getuid!() !== 0) expect(unsafeControlDir("/")).toBe("owned by uid 0");
      expect(unsafeControlSocket(join(ok, "x.sock"))).toBe("missing");
      expect(unsafeControlSocket(file)).toBe("not a socket");
      const sockLink = join(base, "s.sock");
      symlinkSync(file, sockLink);
      expect(unsafeControlSocket(sockLink)).toBe("symlink");
      // A root-owned socket, where the OS has one.
      const rootSock = "/var/run/mDNSResponder";
      if (process.getuid!() !== 0 && existsSync(rootSock) && statSync(rootSock).isSocket()) {
        expect(unsafeControlSocket(rootSock)).toBe("owned by uid 0");
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
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

  test("keeps a 0-column TTY width and merges stderr into stdout for 2>&1", () => {
    const writes: string[] = [];
    const stdout = { write: (c: string) => writes.push(`out:${c}`) } as unknown as NodeJS.WriteStream;
    const stderr = { write: (c: string) => writes.push(`err:${c}`) } as unknown as NodeJS.WriteStream;
    const proc = { argv: [], env: {}, chdir: () => {}, stdout, stderr } as unknown as NodeJS.Process;
    adoptCaller(
      {
        t: "run",
        fingerprint: {} as never,
        argv: [],
        cwd: "/",
        env: {},
        tty: { stdout: { isTTY: true, columns: 0 }, stderr: { isTTY: true, columns: 0 } },
        sharedOutput: true,
      },
      proc,
    );
    expect(stdout.columns).toBe(0);
    proc.stderr.write("a");
    proc.stdout.write("b");
    expect(writes).toEqual(["out:a", "out:b"]);
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
  let driverFile: string;
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
      [join(import.meta.dir, "fixtures/control-race-driver.ts"), "race-driver.js"],
    ] as const) {
      const result = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", outdir: dist, naming });
      if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    }
    binFile = join(dist, "serve-sim.js");
    mainFile = join(dist, "serve-sim-cli.js");
    driverFile = join(dist, "race-driver.js");
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
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      [CONTROL_DIR_ENV]: ctlDir,
      SERVE_SIM_CONTROL_IDLE_MS: "60000",
      // Slow CI must not turn dispatches into in-process runs.
      SERVE_SIM_CONTROL_ACCEPT_MS: "30000",
    };
    delete e.CI;
    for (const k of ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "MARKER", "FAKE_WORKER_LOAD_FAIL"]) delete e[k];
    delete e.SERVE_SIM_CONTROL;
    delete e.EXIT_CODE;
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete e[k];
      else e[k] = v;
    }
    return e;
  }

  type Run = { code: number | null; signal: string | null; stdout: string; stderr: string };

  function run(cmd: string, argv: string[], opts: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<Run> {
    return new Promise((resolve) => {
      const child = spawn(cmd, argv, { cwd: opts.cwd ?? work, env: env(opts.env) });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  }

  function cli(
    args: string[],
    opts: { env?: Record<string, string | undefined>; cwd?: string; nodeArgs?: string[] } = {},
  ): Promise<Run> {
    return run(nodePath!, [...(opts.nodeArgs ?? []), binFile, ...args], opts);
  }

  const paths = () => controlPaths({ binFile, execPath: nodePath!, env: env() });
  const daemonPids = () =>
    spawnSync("pgrep", ["-f", `${binFile} __control-daemon`], { encoding: "utf8" })
      .stdout.split("\n")
      .filter(Boolean);

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
    // Losers notice the takeover on their next ownership check.
    await until(async () => daemonPids().length === 1);
    expect(daemonPids()).toEqual([String(s.pid)]);
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
  // ─── Review regressions ──────────────────────────────────────────────

  function race(o: { stallAfter: string; stallMs: number; acceptTimeoutMs: number; marker: string }) {
    return run(nodePath!, [driverFile], {
      env: {
        MARKER: o.marker,
        RACE_OPTS: JSON.stringify({ binFile, mainFile, argv: ["tap", "1", "1"], ...o }),
      },
    }).then((r) => {
      const line = r.stderr.split("\n").find((l) => l.startsWith("RESULT "));
      return { ...r, result: JSON.parse(line!.slice(7)) as { kind: string; reason?: string; code?: number; signal?: string | null } };
    });
  }

  const ranCount = (marker: string) => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0);

  test("an accept timeout that fires before go never also runs the command in a worker", async () => {
    await startDaemon();
    const marker = join(work, "ran.txt");
    // The client stalls right after `run`, so by the time it looks again its
    // timer has expired even though `accepted` is waiting in the buffer.
    const r = await race({ stallAfter: "run", stallMs: 400, acceptTimeoutMs: 50, marker });
    expect(r.result).toEqual({ kind: "bypass", reason: "accept timeout" });
    // The held worker went back to the pool untouched.
    await until(async () => {
      const s = await status();
      return s.busy === 0 && (s.warm ?? 0) >= 1;
    });
    expect((await status()).served).toBe(0);
    expect(ranCount(marker)).toBe(0);
  });

  test("once go is sent, a stall past the timeout never falls back", async () => {
    await startDaemon();
    const marker = join(work, "ran.txt");
    const r = await race({ stallAfter: "go", stallMs: 1500, acceptTimeoutMs: 1000, marker });
    expect(r.result).toEqual({ kind: "done", code: 0, signal: null });
    expect(ranCount(marker)).toBe(1);
    expect((await status()).served).toBe(1);
  });

  test("refuses a group/other-writable or symlinked control dir", async () => {
    chmodSync(ctlDir, 0o777);
    const r = await cli(["tap", "1", "1"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).argv).toEqual(["tap", "1", "1"]);
    const start = await cli(["control", "start"]);
    expect(start.code).toBe(1);
    expect(start.stderr).toMatch(/can't start: .* group\/other accessible/);
    // The daemon itself refuses too.
    const direct = await cli(["__control-daemon"]);
    expect(direct.code).toBe(1);
    expect(direct.stderr).toMatch(/refused to start/);
    await Bun.sleep(200);
    expect(daemonPids()).toEqual([]);
    chmodSync(ctlDir, 0o700);

    const real = mkdtempSync(join(root, "real"));
    const link = join(root, `link-${Date.now()}`);
    symlinkSync(real, link);
    const viaLink = { env: { [CONTROL_DIR_ENV]: link } };
    expect((await cli(["control", "start"], viaLink)).stderr).toMatch(/symlink/);
    expect((await cli(["tap", "1", "1"], viaLink)).code).toBe(0);
    await Bun.sleep(200);
    expect(daemonPids()).toEqual([]);
  });

  test("never sends a command to a planted (symlinked) socket", async () => {
    const elsewhere = mkdtempSync(join(root, "e"));
    const planted = join(elsewhere, "p.sock");
    const log = join(elsewhere, "received");
    const listener = spawn(nodePath!, [
      "-e",
      `const fs=require("fs");require("net").createServer(c=>c.on("data",d=>fs.appendFileSync(${JSON.stringify(log)},d))).listen(${JSON.stringify(planted)},()=>console.log("up"))`,
    ]);
    stray.push(listener);
    await new Promise<void>((resolve) => listener.stdout.on("data", () => resolve()));
    symlinkSync(planted, paths().socket);
    const r = await cli(["tap", "1", "1"], { env: { SECRET_TOKEN: "hunter2" } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).argv).toEqual(["tap", "1", "1"]);
    await Bun.sleep(100);
    expect(existsSync(log)).toBe(false);
  });

  test("binds its socket owner-only", async () => {
    await startDaemon();
    expect(statSync(paths().socket).mode & 0o777).toBe(0o600);
    expect(statSync(ctlDir).mode & 0o077).toBe(0);
  });

  test("workers that can't load: start fails loudly, callers run in-process, no respawn loop", async () => {
    const broken = { env: { FAKE_WORKER_LOAD_FAIL: "1" } };
    const start = await cli(["control", "start"], broken);
    expect(start.code).toBe(1);
    expect(start.stderr).toContain("workers failed to load the CLI");
    expect(start.stderr).toContain("cannot load ws");
    expect(existsSync(paths().failFile)).toBe(true);
    await until(async () => daemonPids().length === 0);

    // In-process still works, and the fail marker stops auto-start.
    for (let i = 0; i < 3; i++) expect(await cli(["--version"], broken)).toMatchObject({ code: 0, stdout: "fake 1.0.0\n" });
    await Bun.sleep(300);
    expect(daemonPids()).toEqual([]);

    // A caller queued on such a daemon is told to bypass, not exit 1.
    rmSync(paths().failFile);
    const daemon = spawn(nodePath!, [binFile, "__control-daemon"], { env: env(broken.env), stdio: "ignore" });
    stray.push(daemon);
    const r = await cli(["tap", "1", "1"], broken);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).argv).toEqual(["tap", "1", "1"]);
    await new Promise((res) => (daemon.exitCode != null ? res(null) : daemon.on("close", res)));
  });

  test("a write over 64 KB followed by process.exit arrives intact", async () => {
    await startDaemon();
    const r = await cli(["event-log", "500000"]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(500_000);
    expect((await status()).served).toBe(1);
  });

  test("keeps stdout/stderr order under 2>&1", async () => {
    const daemon = await startDaemon();
    const expected = Array.from({ length: 40 }, (_, i) => `out${i}\nerr${i}\n`).join("") + `ppid ${daemon.pid}\n`;
    for (let i = 0; i < 3; i++) {
      const r = await run("/bin/sh", ["-c", `exec "$0" "$1" gesture 2>&1`, nodePath!, binFile]);
      expect(r.stdout).toBe(expected);
    }
    // Separate streams stay separate.
    const split = await cli(["gesture"]);
    expect(split.stderr).toBe(Array.from({ length: 40 }, (_, i) => `err${i}\n`).join(""));
  });

  test("the first caller's NODE_OPTIONS doesn't leak; callers with node flags run in-process", async () => {
    const pre = join(work, "pre.cjs");
    writeFileSync(pre, `globalThis.__pre = "preloaded-by-first-caller";`);
    const withPre = { env: { NODE_OPTIONS: `--require ${pre}` } };
    const start = await cli(["control", "start", "--json"], withPre);
    expect(start.code).toBe(0);
    const { pid } = JSON.parse(start.stdout);
    await warm();
    const plain = JSON.parse((await cli(["buffer"])).stdout);
    expect(plain).toMatchObject({ pre: null, nodeOptions: null, ppid: pid });
    const own = JSON.parse((await cli(["buffer"], withPre)).stdout);
    expect(own.pre).toBe("preloaded-by-first-caller");
    expect(own.ppid).not.toBe(pid);
    const flagged = JSON.parse((await cli(["buffer"], { nodeArgs: ["--no-warnings"] })).stdout);
    expect(flagged.execArgv).toEqual(["--no-warnings"]);
    expect(flagged.ppid).not.toBe(pid);
  });

  test("works from a deleted cwd, with and without the control process", async () => {
    const gone = join(work, "gone");
    const script = `mkdir "$2" && cd "$2" && rmdir "$2" && exec "$0" "$1" --version`;
    for (const extra of [{ SERVE_SIM_CONTROL: "0" }, {}]) {
      const r = await run("/bin/sh", ["-c", script, nodePath!, binFile, gone], { env: extra });
      expect(r).toMatchObject({ code: 0, stdout: "fake 1.0.0\n" });
    }
    await startDaemon();
    const r = await run("/bin/sh", ["-c", script, nodePath!, binFile, gone]);
    expect(r).toMatchObject({ code: 0, stdout: "fake 1.0.0\n" });
  });

  test("the daemon re-checks that a command may run in a worker", async () => {
    await startDaemon();
    const { createConnection } = await import("net");
    const fp = controlFingerprint({ binFile, mainFile, execPath: nodePath!, env: env() });
    const reply = await new Promise<string>((resolve) => {
      const c = createConnection(paths().socket);
      let data = Buffer.alloc(0);
      c.on("connect", () =>
        c.write(
          encodeJson({
            t: "run",
            fingerprint: fp,
            argv: ["--port", "3412"],
            cwd: "/",
            env: {},
            tty: { stdout: { isTTY: false }, stderr: { isTTY: false } },
          }),
        ),
      );
      c.on("data", (d) => (data = Buffer.concat([data, Buffer.from(d)])));
      c.on("close", () => resolve(new FrameDecoder().push(data).map((f) => f.payload.toString()).join("")));
    });
    expect(JSON.parse(reply)).toEqual({ t: "bypass", reason: "not dispatchable" });
    expect((await status()).busy).toBe(0);
  });
  test("a stop request lets a running command finish", async () => {
    const daemon = await startDaemon();
    const child = spawn(nodePath!, [binFile, "settle"], { cwd: work, env: env() });
    stray.push(child);
    let stdout = "";
    await new Promise<void>((resolve) =>
      child.stdout.on("data", (d) => {
        stdout += d;
        if (stdout.includes("waiting")) resolve();
      }),
    );
    const { createConnection } = await import("net");
    await new Promise<void>((resolve) => {
      const c = createConnection(paths().socket);
      c.on("connect", () => c.write(encodeJson({ t: "stop" })));
      c.resume();
      c.on("close", () => resolve());
    });
    // Longer than the daemon's reply-drain window.
    await Bun.sleep(1500);
    expect(child.exitCode).toBeNull();
    child.kill("SIGINT");
    const code = await new Promise((r) => child.on("close", (c) => r(c)));
    expect(code).toBe(130);
    expect(stdout).toBe("waiting\ngot SIGINT\n");
    await until(async () => {
      try {
        process.kill(daemon.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});
