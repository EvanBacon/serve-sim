import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { eventLogEventForCommand } from "../event-log";
import { previewConfigForState, readServeSimStates, rewriteStateForRequestHost, type ServeSimState } from "../middleware";
import { STATE_DIR, stateFileForDevice } from "../state";
import { sameDeviceSet, simctlArguments, simctlBootStatusArguments, simulatorDevicesDir } from "../simctl";

// `--device-set <path>` / SERVE_SIM_DEVICE_SET: simulators a tool keeps in a
// CoreSimulator set of its own. Every simctl call gets `--set <path>` and the
// per-simulator data folders live under the set instead of Xcode's default.

const DEVICE_SET_ENV = "SERVE_SIM_DEVICE_SET";
const simctlModule = join(import.meta.dir, "..", "simctl.ts");
const MISSING_SET = join(tmpdir(), "serve-sim-no-such-set");

/**
 * Runs `body` in a fresh process, where the device set is not settled yet
 * (this file's process settles it once, to Xcode's default). `body` sees
 * the simctl module as `m` and returns what it observed.
 */
function inFreshProcess(
  body: string,
  { env = {}, cwd }: { env?: Record<string, string>; cwd?: string } = {},
): { ok: true; value: unknown } | { ok: false; error: string } {
  const script =
    `const m = await import(${JSON.stringify(simctlModule)});` +
    `try { console.log(JSON.stringify({ ok: true, value: await (async () => { ${body} })() })); }` +
    `catch (error) { console.log(JSON.stringify({ ok: false, error: String(error.message) })); }`;
  const base = { ...process.env };
  delete base[DEVICE_SET_ENV];
  const result = spawnSync("bun", ["-e", script], { encoding: "utf8", env: { ...base, ...env }, cwd });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

function withSet<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-set-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("simctlArguments", () => {
  test("targets Xcode's default set when none is configured", () => {
    expect(simctlArguments(["list", "devices", "-j"])).toEqual(["simctl", "list", "devices", "-j"]);
    expect(inFreshProcess(`return m.simctlArguments(["list"]);`, { env: { [DEVICE_SET_ENV]: " " } })).toEqual({
      ok: true,
      value: ["simctl", "list"],
    });
  });

  test("puts the configured set before the verb", () => {
    withSet((dir) => {
      expect(
        inFreshProcess(`return [m.simctlArguments(["launch", "UDID", "com.example"]), m.simctlBootStatusArguments("UDID")];`, {
          env: { [DEVICE_SET_ENV]: dir },
        }),
      ).toEqual({
        ok: true,
        value: [
          ["simctl", "--set", dir, "launch", "UDID", "com.example"],
          ["simctl", "--set", dir, "bootstatus", "UDID"],
        ],
      });
    });
    expect(simctlBootStatusArguments("UDID")).toEqual(["simctl", "bootstatus", "UDID"]);
  });
});

describe("resolveDeviceSet", () => {
  test("reads ~ and relative paths from SERVE_SIM_DEVICE_SET as the CLI does, for embedders that never run it", () => {
    withSet((dir) => {
      mkdirSync(join(dir, "pool"));
      const resolve = `return m.resolveDeviceSet();`;
      expect(inFreshProcess(resolve, { env: { [DEVICE_SET_ENV]: "pool/" }, cwd: dir })).toEqual({
        ok: true,
        value: join(realpathSync(dir), "pool"),
      });
      expect(inFreshProcess(resolve, { env: { [DEVICE_SET_ENV]: ` ${dir}/ ` } })).toEqual({ ok: true, value: dir });
      expect(inFreshProcess(resolve, { env: { [DEVICE_SET_ENV]: "~" } })).toEqual({ ok: true, value: homedir() });
    });
  });

  test("resolves --device-set to an absolute directory", () => {
    withSet((dir) => {
      expect(inFreshProcess(`return m.resolveDeviceSet(".");`, { cwd: dir })).toEqual({ ok: true, value: realpathSync(dir) });
      expect(inFreshProcess(`return m.resolveDeviceSet("~");`)).toEqual({ ok: true, value: homedir() });
    });
  });

  test("rejects an empty value and a missing directory, naming where it came from", () => {
    const missing = join(tmpdir(), "serve-sim-no-such-set");
    for (const [body, env, source] of [
      [`return m.resolveDeviceSet("");`, {}, "--device-set"],
      [`return m.resolveDeviceSet(${JSON.stringify(missing)});`, {}, "--device-set"],
      [`return m.resolveDeviceSet();`, { [DEVICE_SET_ENV]: missing }, DEVICE_SET_ENV],
    ] as const) {
      const result = inFreshProcess(body, { env });
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error).toStartWith(`${source}: `);
    }
  });

  test("takes --device-set over SERVE_SIM_DEVICE_SET, even a missing one", () => {
    withSet((dir) => {
      expect(
        inFreshProcess(`return m.resolveDeviceSet(${JSON.stringify(dir)});`, {
          env: { [DEVICE_SET_ENV]: join(tmpdir(), "serve-sim-no-such-set") },
        }),
      ).toEqual({ ok: true, value: dir });
    });
  });

  test("hands the set to the processes serve-sim starts, and leaves no variable for the default set", () => {
    withSet((dir) => {
      expect(
        inFreshProcess(`m.resolveDeviceSet(${JSON.stringify(dir)}); return process.env.${DEVICE_SET_ENV};`),
      ).toEqual({ ok: true, value: dir });
      expect(
        inFreshProcess(`m.resolveDeviceSet(); return "${DEVICE_SET_ENV}" in process.env;`, { env: { [DEVICE_SET_ENV]: " " } }),
      ).toEqual({ ok: true, value: false });
    });
  });

  test("settles once: later calls keep the first answer, and a late --device-set throws", () => {
    withSet((dir) => {
      expect(
        inFreshProcess(`m.simctlArguments(["list"]); process.env.${DEVICE_SET_ENV} = ${JSON.stringify(dir)}; return m.resolveDeviceSet() ?? null;`),
      ).toEqual({ ok: true, value: null });
      const late = inFreshProcess(`m.simctlArguments(["list"]); return m.resolveDeviceSet(${JSON.stringify(dir)});`);
      expect(late.ok ? "" : late.error).toContain("--device-set arrived after the device set was settled");
    });
  });
});

describe("sameDeviceSet", () => {
  test("matches one set through a symlink, and only the default with the default", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-set-"));
    const link = `${dir}-link`;
    try {
      symlinkSync(dir, link);
      expect(sameDeviceSet(link, realpathSync(dir))).toBe(true);
      expect(sameDeviceSet(dir, join(dir, "other"))).toBe(false);
      expect(sameDeviceSet(undefined, undefined)).toBe(true);
      expect(sameDeviceSet(undefined, dir)).toBe(false);
    } finally {
      rmSync(link, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("takes Xcode's default folder named explicitly for the default set", () => {
    const xcodeDefault = join(homedir(), "Library/Developer/CoreSimulator/Devices");
    expect(sameDeviceSet(undefined, xcodeDefault)).toBe(true);
    expect(sameDeviceSet(`${xcodeDefault}/`, undefined)).toBe(true);
  });
});

describe("simulatorDevicesDir", () => {
  test("is Xcode's default folder, or the set itself", () => {
    expect(simulatorDevicesDir()).toBe(join(homedir(), "Library/Developer/CoreSimulator/Devices"));
    withSet((dir) => {
      expect(inFreshProcess(`return m.simulatorDevicesDir();`, { env: { [DEVICE_SET_ENV]: dir } })).toEqual({ ok: true, value: dir });
    });
  });
});

describe("readServeSimStates", () => {
  test("lists only the previews of this process's device set", async () => {
    // Labels, not UDIDs, so neither state is recycled as shut down.
    const ours = `SERVE-SIM-TEST-OURS-${process.pid}`;
    const theirs = `SERVE-SIM-TEST-THEIRS-${process.pid}`;
    const record = (device: string, extra: Partial<ServeSimState>): ServeSimState => ({
      pid: process.pid,
      port: 1,
      device,
      url: "http://127.0.0.1:1",
      streamUrl: `http://127.0.0.1:1/helper/${device}/stream.mjpeg`,
      wsUrl: `ws://127.0.0.1:1/helper/${device}/ws`,
      ...extra,
    });
    mkdirSync(STATE_DIR, { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-set-"));
    try {
      writeFileSync(stateFileForDevice(ours), JSON.stringify(record(ours, {})));
      writeFileSync(stateFileForDevice(theirs), JSON.stringify(record(theirs, { deviceSet: dir })));
      const listed = (await readServeSimStates()).map((state) => state.device);
      expect(listed).toContain(ours);
      expect(listed).not.toContain(theirs);
    } finally {
      rmSync(stateFileForDevice(ours), { force: true });
      rmSync(stateFileForDevice(theirs), { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("served state", () => {
  test("keeps the host's device-set path out of what the page and /api send", () => {
    const state: ServeSimState = {
      pid: 1, port: 3200, device: "UDID", url: "", streamUrl: "", wsUrl: "", deviceSet: "/Users/me/pool",
    };
    for (const value of [
      previewConfigForState(state, "", "serve-sim", true),
      rewriteStateForRequestHost(state, "127.0.0.1:3200"),
      rewriteStateForRequestHost(state, "192.168.1.5:3200", "/.sim", "https", true),
    ]) {
      expect(JSON.stringify(value)).not.toContain("/Users/me/pool");
    }
  });
});

describe("event log", () => {
  test("reads the verb after a device set", () => {
    const event = eventLogEventForCommand("xcrun simctl --set /pool/devices install UDID /tmp/App.app", { exitCode: 0 });
    expect(event?.action).toBe("install");
    expect(event?.device).toBe("UDID");
  });
});

describe("serve-sim --device-set", () => {
  const cli = join(import.meta.dir, "..", "index.ts");

  test("is documented in --help", () => {
    const result = spawnSync("bun", [cli, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--device-set <path>");
    expect(result.stdout).toContain(DEVICE_SET_ENV);
  });

  test("rejects a missing directory before starting anything", () => {
    const result = spawnSync("bun", [cli, "--device-set", join(tmpdir(), "serve-sim-no-such-set"), "--list"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--device-set");
  });

  test("applies to subcommands too", () => {
    for (const args of [["--device-set", MISSING_SET, "event-log"], ["event-log", "--device-set", MISSING_SET]]) {
      const result = spawnSync("bun", [cli, ...args], { encoding: "utf8" });
      expect({ args, status: result.status }).toEqual({ args, status: 1 });
      expect(result.stderr).toContain("--device-set");
    }
  });

  test("rejects a missing SERVE_SIM_DEVICE_SET before starting anything", () => {
    const result = spawnSync("bun", [cli, "--list"], {
      encoding: "utf8",
      env: { ...process.env, [DEVICE_SET_ENV]: join(tmpdir(), "serve-sim-no-such-set") },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(DEVICE_SET_ENV);
  });

  test("takes a valid --device-set over a missing SERVE_SIM_DEVICE_SET", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-set-"));
    try {
      const result = spawnSync("bun", [cli, "--device-set", dir, "--list"], {
        encoding: "utf8",
        env: { ...process.env, [DEVICE_SET_ENV]: join(tmpdir(), "serve-sim-no-such-set") },
      });
      expect(result.stderr).not.toContain(DEVICE_SET_ENV);
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
