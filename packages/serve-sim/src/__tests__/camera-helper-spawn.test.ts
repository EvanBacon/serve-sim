import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CAMERA_STATE_DIR,
  cameraHelperBundlesFile,
  cameraHelperPidFile,
} from "../camera-helper";
import { spawnCameraHelper, stopExistingHelper } from "../camera-helper-process";

// Host side of `serve-sim camera`: the CLI spawns `serve-sim-camera-helper`,
// records its pid, waits for its control socket, and later SIGTERMs it so it
// can unlink its shm region. A stand-in helper (a shell script) records what
// it was launched with, so the argv the Swift helper parses, the env it
// inherits, its detachment from the short-lived CLI, its log, and the
// cleanup are all checked without building the real helper or a simulator.

const FAKE_HELPER = `#!/bin/sh
rec="$SIMCAM_FAKE_RECORD"
printf '%s\\n' "$@" > "$rec.argv"
env > "$rec.env"
echo "fake helper stdout"
echo "fake helper stderr" >&2
[ "$SIMCAM_FAKE_MODE" = exit ] && exit 3
sock=""
while [ $# -gt 0 ]; do [ "$1" = --socket ] && sock="$2"; shift; done
trap 'sleep 0.2; rm -f "$sock"; echo terminated > "$rec.term"; exit 0' TERM
[ "$SIMCAM_FAKE_MODE" = slow ] && sleep 0.4
: > "$sock"
while :; do sleep 0.05; done
`;

let dir = "";
let helperBin = "";
const udids: string[] = [];
const pids: number[] = [];
const savedEnv = { ...process.env };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  // An exited-but-unreaped child still answers kill(0); ps shows it as Z.
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return stat !== "" && !stat.startsWith("Z");
}

function setup(mode: "ready" | "slow" | "exit" = "ready") {
  const udid = `CAMSPAWN-${randomUUID().toUpperCase()}`;
  udids.push(udid);
  const record = join(dir, udid);
  process.env.SIMCAM_FAKE_RECORD = record;
  process.env.SIMCAM_FAKE_MODE = mode;
  const socketPath = join(dir, `${udid.slice(-8)}.sock`);
  const read = (suffix: string) => readFileSync(`${record}.${suffix}`, "utf8");
  return { udid, record, socketPath, read, logPath: join(CAMERA_STATE_DIR, `${udid}.log`) };
}

async function spawnFake(t: ReturnType<typeof setup>, extra: { arg?: string; width?: number; height?: number } = {}) {
  const pid = await spawnCameraHelper({
    udid: t.udid,
    helperBin,
    shmName: "/serve-sim-cam-1a2b3c4d",
    socketPath: t.socketPath,
    source: extra.arg ? "image" : "placeholder",
    ...extra,
  });
  pids.push(pid);
  return pid;
}

beforeAll(() => {
  mkdirSync(CAMERA_STATE_DIR, { recursive: true });
  dir = mkdtempSync(join(tmpdir(), "serve-sim-camspawn-"));
  helperBin = join(dir, "serve-sim-camera-helper");
  writeFileSync(helperBin, FAKE_HELPER);
  chmodSync(helperBin, 0o755);
});

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  for (const key of ["SIMCAM_FAKE_RECORD", "SIMCAM_FAKE_MODE", "DEVELOPER_DIR", "SERVE_SIM_DEVICE_SET"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(() => {
  for (const udid of udids) {
    for (const file of [cameraHelperPidFile(udid), cameraHelperBundlesFile(udid), join(CAMERA_STATE_DIR, `${udid}.log`)]) {
      try { unlinkSync(file); } catch {}
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("camera helper spawn", () => {
  test("passes the shm name, socket and source the helper parses, in order", async () => {
    const t = setup();
    await spawnFake(t);
    expect(t.read("argv").split("\n").slice(0, -1)).toEqual([
      "--shm", "/serve-sim-cam-1a2b3c4d",
      "--socket", t.socketPath,
      "--source", "placeholder",
    ]);
  });

  test("a source argument and frame size are appended as their own flags", async () => {
    const t = setup();
    await spawnFake(t, { arg: "/Users/me/Pictures/face with space.png", width: 1280, height: 720 });
    expect(t.read("argv").split("\n").slice(0, -1)).toEqual([
      "--shm", "/serve-sim-cam-1a2b3c4d",
      "--socket", t.socketPath,
      "--source", "image",
      "--arg", "/Users/me/Pictures/face with space.png",
      "--width", "1280",
      "--height", "720",
    ]);
  });

  test("the helper inherits the host env (Xcode selection, device set, PATH, HOME)", async () => {
    process.env.DEVELOPER_DIR = "/Applications/Xcode-beta.app/Contents/Developer";
    process.env.SERVE_SIM_DEVICE_SET = join(dir, "private set");
    const t = setup();
    await spawnFake(t);
    const env = new Map(t.read("env").split("\n").map((line) => {
      const eq = line.indexOf("=");
      return [line.slice(0, eq), line.slice(eq + 1)] as const;
    }));
    expect(env.get("DEVELOPER_DIR")).toBe("/Applications/Xcode-beta.app/Contents/Developer");
    expect(env.get("SERVE_SIM_DEVICE_SET")).toBe(join(dir, "private set"));
    expect(env.get("PATH")).toBe(process.env.PATH);
    expect(env.get("HOME")).toBe(process.env.HOME);
  });

  test("runs in its own process group so it outlives the CLI, with output appended to the per-UDID log", async () => {
    const t = setup();
    const first = await spawnFake(t);
    const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(first)], { encoding: "utf8" }).trim());
    expect(pgid).toBe(first);
    expect(pgid).not.toBe(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim()));

    stopExistingHelper(t.udid);
    await spawnFake(t);
    const log = readFileSync(t.logPath, "utf8");
    expect(log.match(/fake helper stdout/g)).toHaveLength(2);
    expect(log.match(/fake helper stderr/g)).toHaveLength(2);
  });

  test("records the helper pid, drops the previous helper's bundles, and returns once the socket exists", async () => {
    const t = setup("slow");
    writeFileSync(cameraHelperBundlesFile(t.udid), JSON.stringify({ helperPid: 1, bundleIds: ["com.stale.App"] }));
    const started = Date.now();
    const pid = await spawnFake(t);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(existsSync(t.socketPath)).toBe(true);
    expect(readFileSync(cameraHelperPidFile(t.udid), "utf8")).toBe(String(pid));
    expect(existsSync(cameraHelperBundlesFile(t.udid))).toBe(false);
    expect(alive(pid)).toBe(true);
  });

  test("a helper binary that cannot be launched fails the command and records no pid", () => {
    const udid = `CAMSPAWN-${randomUUID().toUpperCase()}`;
    udids.push(udid);
    const missing = join(dir, "no-such-helper");
    const script = `
      import { spawnCameraHelper } from ${JSON.stringify(join(import.meta.dir, "..", "camera-helper-process.ts"))};
      await spawnCameraHelper({ udid: ${JSON.stringify(udid)}, helperBin: ${JSON.stringify(missing)},
        shmName: "/x", socketPath: ${JSON.stringify(join(dir, "never.sock"))}, source: "placeholder" });
      console.log("SPAWNED");
    `;
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 15_000 });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("SPAWNED");
    expect(r.stderr).toContain("failed to spawn camera helper");
    expect(existsSync(cameraHelperPidFile(udid))).toBe(false);
  }, 20_000);

  test("a helper that exits at startup is reported promptly with its log path", async () => {
    const t = setup("exit");
    const started = Date.now();
    await expect(spawnFake(t)).rejects.toThrow(`camera helper exited early — see log at ${t.logPath}`);
    // Well under the 3 s socket wait: the exit is seen, not timed out.
    expect(Date.now() - started).toBeLessThan(1500);
  }, 10_000);
});

describe("camera helper stop", () => {
  test("SIGTERMs the helper, waits for it to exit, and removes its pid and bundles files", async () => {
    const t = setup();
    const pid = await spawnFake(t);
    writeFileSync(cameraHelperBundlesFile(t.udid), JSON.stringify({ helperPid: pid, bundleIds: ["com.acme.App"] }));
    stopExistingHelper(t.udid);
    expect(alive(pid)).toBe(false);
    expect(t.read("term").trim()).toBe("terminated");
    // The helper's own TERM handler ran to completion: it removed its socket.
    expect(existsSync(t.socketPath)).toBe(false);
    expect(existsSync(cameraHelperPidFile(t.udid))).toBe(false);
    expect(existsSync(cameraHelperBundlesFile(t.udid))).toBe(false);
  });

  test("a pid file left by a dead helper is cleared along with its bundles", () => {
    const t = setup();
    const dead = spawnSync("/usr/bin/true").pid!;
    writeFileSync(cameraHelperPidFile(t.udid), String(dead));
    writeFileSync(cameraHelperBundlesFile(t.udid), JSON.stringify({ helperPid: dead, bundleIds: ["com.acme.App"] }));
    stopExistingHelper(t.udid);
    expect(existsSync(cameraHelperPidFile(t.udid))).toBe(false);
    expect(existsSync(cameraHelperBundlesFile(t.udid))).toBe(false);
  });
});
