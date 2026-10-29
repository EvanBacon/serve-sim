import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { eventLogEventForCommand } from "../event-log";
import {
  DEVICE_SET_ENV,
  applyDeviceSetOption,
  deviceSetFromEnv,
  parseDeviceSetPath,
  simctlArguments,
  simctlBootStatusArguments,
  simulatorDevicesDir,
} from "../simctl";

// `--device-set <path>` / SERVE_SIM_DEVICE_SET: simulators a tool keeps in a
// CoreSimulator set of its own. Every simctl call gets `--set <path>` and the
// per-simulator data folders live under the set instead of Xcode's default.

describe("simctlArguments", () => {
  test("targets Xcode's default set when none is configured", () => {
    expect(simctlArguments(["list", "devices", "-j"], {})).toEqual(["simctl", "list", "devices", "-j"]);
    expect(simctlArguments(["list"], { [DEVICE_SET_ENV]: " " })).toEqual(["simctl", "list"]);
  });

  test("puts the configured set before the verb", () => {
    const env = { [DEVICE_SET_ENV]: "/pool/devices" };
    expect(simctlArguments(["launch", "UDID", "com.example"], env)).toEqual([
      "simctl", "--set", "/pool/devices", "launch", "UDID", "com.example",
    ]);
    expect(simctlBootStatusArguments("UDID", env)).toEqual(["simctl", "--set", "/pool/devices", "bootstatus", "UDID"]);
  });
});

describe("simulatorDevicesDir", () => {
  test("is Xcode's default folder, or the set itself", () => {
    expect(simulatorDevicesDir({}, "/Users/me")).toBe("/Users/me/Library/Developer/CoreSimulator/Devices");
    expect(simulatorDevicesDir({ [DEVICE_SET_ENV]: "/pool/devices" }, "/Users/me")).toBe("/pool/devices");
  });
});

describe("parseDeviceSetPath", () => {
  test("resolves an existing directory to an absolute path", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-set-"));
    try {
      expect(parseDeviceSetPath(".", dir)).toBe(dir);
      expect(parseDeviceSetPath("~", "/")).toBe(homedir());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an empty value and a missing directory", () => {
    expect(() => parseDeviceSetPath("")).toThrow();
    expect(() => parseDeviceSetPath(join(tmpdir(), "serve-sim-no-such-set"))).toThrow();
  });
});

describe("applyDeviceSetOption", () => {
  test("hands the flag to child processes and leaves the environment alone without it", () => {
    const env: NodeJS.ProcessEnv = {};
    applyDeviceSetOption(undefined, env);
    expect(deviceSetFromEnv(env)).toBeUndefined();
    applyDeviceSetOption("/pool/devices", env);
    expect(deviceSetFromEnv(env)).toBe("/pool/devices");
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
    expect(result.stdout).toContain("--restrict-devices");
  });

  test("rejects a missing directory before starting anything", () => {
    const result = spawnSync("bun", [cli, "--device-set", join(tmpdir(), "serve-sim-no-such-set"), "--list"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--device-set");
  });

  test("--restrict-devices refuses modes without the preview server", () => {
    for (const mode of ["--detach", "--no-preview"]) {
      const result = spawnSync("bun", [cli, "--restrict-devices", mode], { encoding: "utf8" });
      expect({ mode, status: result.status }).toEqual({ mode, status: 1 });
      expect(result.stderr).toContain("--restrict-devices applies to the preview server");
    }
  });
});
