/**
 * Helper lifecycle for issue #102 (orphan after simctl shutdown).
 *
 * These tests do not need a live Simulator and are safe on Linux CI. Darwin
 * verification still needed on a Mac: `serve-sim --detach <udid>`, then
 * `xcrun simctl shutdown <udid>`, then confirm the helper exits within the
 * grace window and that `--list` / `--kill` track it while it is still alive.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
  classifyStaleState,
  collectKillPids,
  createSimulatorShutdownWatch,
  formatListPayload,
  looksLikeServeSimProcess,
  parseDeviceState,
  resolveLiveHelperState,
  SIMULATOR_SHUTDOWN_GRACE_MS,
} from "../helper-lifecycle";
import { STATE_DIR, stateFileForDevice, type ServeSimDeviceState } from "../state";

/** Last JSON object on stdout — `--kill` may print a port-reaper line first. */
function lastJsonLine(stdout: string): string {
  const lines = stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith("{") || line.startsWith("[")) return line;
  }
  return stdout.trim();
}

const UDID = "00000000-0000-4000-8000-000000000102";
const OTHER = "11111111-1111-4111-8111-111111111111";

function state(overrides: Partial<ServeSimDeviceState> = {}): ServeSimDeviceState {
  return {
    pid: 4242,
    port: 3100,
    device: UDID,
    url: "http://127.0.0.1:3100",
    streamUrl: "http://127.0.0.1:3100/helper/" + UDID + "/stream.mjpeg",
    wsUrl: "ws://127.0.0.1:3100/helper/" + UDID + "/ws",
    ...overrides,
  };
}

describe("classifyStaleState", () => {
  test("keeps a helper when simctl cannot prove the device is gone", () => {
    expect(classifyStaleState(state(), null, 1)).toBe("keep");
  });

  test("keeps a helper whose simulator is still booted", () => {
    expect(classifyStaleState(state(), new Set([UDID]), 1)).toBe("keep");
  });

  test("does not recycle non-UDID device labels", () => {
    expect(classifyStaleState(state({ device: "iPhone 17" }), new Set(), 1)).toBe("keep");
  });

  test("recycles our own in-process session without treating it as a foreign helper", () => {
    expect(classifyStaleState(state({ pid: 99 }), new Set(), 99)).toBe("recycle-self");
  });

  test("recycles a foreign helper bound to a shut-down simulator", () => {
    expect(classifyStaleState(state({ pid: 88 }), new Set(), 99)).toBe("recycle-helper");
  });
});

describe("parseDeviceState / resolveLiveHelperState", () => {
  test("rejects malformed pidfiles", () => {
    expect(parseDeviceState("not-json")).toBeNull();
    expect(parseDeviceState(JSON.stringify({ pid: "x" }))).toBeNull();
  });

  test("keeps a live pid even when the simulator is gone", () => {
    const recorded = state({ pid: 7 });
    expect(resolveLiveHelperState(recorded, {
      isAlive: (pid) => pid === 7,
      portHolders: () => [],
    })).toEqual(recorded);
  });

  test("recovers a dead pidfile via the listen port when the listener looks like serve-sim", () => {
    const recorded = state({ pid: 7 });
    expect(resolveLiveHelperState(recorded, {
      isAlive: (pid) => pid === 88,
      portHolders: (port) => port === 3100 ? [88] : [],
      commandLine: (pid) => pid === 88 ? "node /tmp/serve-sim.js UDID --port 3100" : null,
    })).toEqual({ ...recorded, pid: 88 });
  });

  test("does not steal an unrelated listener on the recorded port", () => {
    expect(resolveLiveHelperState(state({ pid: 7 }), {
      isAlive: (pid) => pid === 88,
      portHolders: () => [88],
      commandLine: () => "nginx: master process",
    })).toBeNull();
  });

  test("drops a dead pid with no listener", () => {
    expect(resolveLiveHelperState(state({ pid: 7 }), {
      isAlive: () => false,
      portHolders: () => [],
    })).toBeNull();
  });
});

describe("formatListPayload", () => {
  test("reports running:false when nothing is tracked", () => {
    expect(formatListPayload([])).toEqual({ running: false });
    expect(formatListPayload([], UDID)).toEqual({ running: false, device: UDID });
  });

  test("reports a live helper as running even if it is the only match", () => {
    const s = state({ pid: 9 });
    expect(formatListPayload([s])).toEqual({
      running: true,
      url: s.url,
      streamUrl: s.streamUrl,
      wsUrl: s.wsUrl,
      port: 3100,
      device: UDID,
      pid: 9,
    });
  });

  test("lists multiple live helpers without collapsing to running:false", () => {
    const a = state({ pid: 1, port: 3100 });
    const b = state({ pid: 2, port: 3101, device: OTHER });
    expect(formatListPayload([a, b])).toEqual({
      running: true,
      streams: [
        { url: a.url, streamUrl: a.streamUrl, wsUrl: a.wsUrl, port: 3100, device: UDID, pid: 1 },
        { url: b.url, streamUrl: b.streamUrl, wsUrl: b.wsUrl, port: 3101, device: OTHER, pid: 2 },
      ],
    });
  });
});

describe("collectKillPids", () => {
  test("includes the recorded pid and any serve-sim port holder", () => {
    expect(collectKillPids(state({ pid: 7 }), {
      selfPid: 1,
      portHolders: () => [7, 88],
      commandLine: (pid) => pid === 88 ? "/opt/serve-sim-bin --port 3100" : "node serve-sim.js",
    }).sort()).toEqual([7, 88]);
  });

  test("does not kill this process or an unrelated port holder", () => {
    expect(collectKillPids(state({ pid: 1 }), {
      selfPid: 1,
      portHolders: () => [1, 99],
      commandLine: (pid) => pid === 99 ? "python3 -m http.server" : "serve-sim",
    })).toEqual([]);
  });
});

describe("looksLikeServeSimProcess", () => {
  test("matches node, npx, and the historical serve-sim-bin helper", () => {
    expect(looksLikeServeSimProcess("node /Users/me/.npm/_npx/serve-sim/dist/serve-sim.js --port 3100")).toBe(true);
    expect(looksLikeServeSimProcess("/opt/serve-sim-bin UDID --port 3100")).toBe(true);
    expect(looksLikeServeSimProcess("node /app/index.js")).toBe(false);
  });
});

describe("createSimulatorShutdownWatch", () => {
  test("does not exit while any target stays booted", async () => {
    const watch = createSimulatorShutdownWatch([UDID, OTHER], {
      checkBooted: async () => new Set([OTHER]),
      now: () => 10_000,
      graceMs: 1_000,
    });
    expect(await watch.tick()).toBe("continue");
    expect(await watch.tick()).toBe("continue");
  });

  test("does not exit when simctl cannot be queried", async () => {
    const watch = createSimulatorShutdownWatch([UDID], {
      checkBooted: async () => null,
      now: () => 50_000,
      graceMs: 1,
    });
    expect(await watch.tick()).toBe("continue");
  });

  test("exits after grace once every target is unbooted", async () => {
    let t = 0;
    const watch = createSimulatorShutdownWatch([UDID], {
      checkBooted: async () => new Set(),
      now: () => t,
      graceMs: 1_000,
    });
    expect(await watch.tick()).toBe("continue");
    t = 999;
    expect(await watch.tick()).toBe("continue");
    t = 1_000;
    expect(await watch.tick()).toBe("exit");
  });

  test("resets grace if the simulator comes back before expiry", async () => {
    let t = 0;
    let booted: Set<string> | null = new Set();
    const watch = createSimulatorShutdownWatch([UDID], {
      checkBooted: async () => booted,
      now: () => t,
      graceMs: 1_000,
    });
    expect(await watch.tick()).toBe("continue");
    t = 500;
    booted = new Set([UDID]);
    expect(await watch.tick()).toBe("continue");
    booted = new Set();
    t = 10_000;
    expect(await watch.tick()).toBe("continue");
    t = 10_999;
    expect(await watch.tick()).toBe("continue");
    t = 11_000;
    expect(await watch.tick()).toBe("exit");
  });

  test("default grace is a few seconds, not a tight spin", () => {
    expect(SIMULATOR_SHUTDOWN_GRACE_MS).toBeGreaterThanOrEqual(3_000);
  });
});

describe("CLI --list / --kill against a live pidfile (no Simulator)", () => {
  const cli = join(import.meta.dir, "../index.ts");
  const file = stateFileForDevice(UDID);
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      try { child.kill("SIGKILL"); } catch {}
    }
    try { unlinkSync(file); } catch {}
  });

  function spawnListener(): Promise<{ child: ChildProcess; pid: number; port: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn("node", ["-e", `
        const net = require("net");
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
          process.title = "serve-sim-test-helper";
          console.log(JSON.stringify({ pid: process.pid, port: srv.address().port }));
        });
      `], { stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      child.stdout!.once("data", (buf) => {
        try {
          resolve({ child, ...JSON.parse(String(buf).trim()) as { pid: number; port: number } });
        } catch (err) {
          reject(err);
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`listener exited early (${code})`)));
    });
  }

  test("--list reports running:true without recycling, then --kill stops the process", async () => {
    const advertised = await spawnListener();
    const { child } = advertised;
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(state({
      pid: advertised.pid,
      port: advertised.port,
    })));

    const listed = spawnSync("bun", ["run", cli, "--list", UDID], {
      encoding: "utf-8",
      timeout: 15_000,
    });
    expect(listed.status).toBe(0);
    const payload = JSON.parse(lastJsonLine(listed.stdout)) as {
      running: boolean;
      pid?: number;
      device?: string;
      port?: number;
    };
    expect(payload).toMatchObject({
      running: true,
      device: UDID,
      pid: advertised.pid,
      port: advertised.port,
    });
    expect(existsSync(file)).toBe(true);
    expect(child.exitCode).toBeNull();

    const killed = spawnSync("bun", ["run", cli, "--kill", UDID], {
      encoding: "utf-8",
      timeout: 15_000,
    });
    expect(killed.status).toBe(0);
    expect(JSON.parse(lastJsonLine(killed.stdout))).toEqual({
      disconnected: true,
      device: UDID,
    });
    expect(existsSync(file)).toBe(false);

    const dead = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(dead).toBe(true);
  });
});
