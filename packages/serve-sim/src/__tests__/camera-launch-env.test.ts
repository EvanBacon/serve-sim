import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cameraLaunchEnv } from "../camera-helper";

// Regression guard for camera injection. `serve-sim camera <bundle>` relies on
// simctl forwarding SIMCTL_CHILD_* into the launched guest app (prefix
// stripped). Dropping the prefix, renaming a variable the dylib reads, or
// losing the host env (PATH, DEVELOPER_DIR for xcrun) makes injection fail
// silently: the app launches with the simulator's stub camera.

const DYLIB = "/opt/serve-sim/dist/simcam/libSimCameraInjector.dylib";
const SHM = "/serve-sim-cam-ABCDEF";

describe("cameraLaunchEnv", () => {
  test("injects the dylib and shm name through simctl's SIMCTL_CHILD_ prefix", () => {
    const env = cameraLaunchEnv({}, DYLIB, SHM, "auto");
    expect(env).toEqual({
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: DYLIB,
      SIMCTL_CHILD_SIMCAM_SHM_NAME: SHM,
    });
  });

  test("auto mirror leaves the mirror mode to the dylib's front/back default", () => {
    expect(cameraLaunchEnv({}, DYLIB, SHM, "auto")).not.toHaveProperty("SIMCTL_CHILD_SIMCAM_MIRROR_MODE");
  });

  test("an explicit mirror mode is forwarded verbatim", () => {
    expect(cameraLaunchEnv({}, DYLIB, SHM, "on").SIMCTL_CHILD_SIMCAM_MIRROR_MODE).toBe("on");
    expect(cameraLaunchEnv({}, DYLIB, SHM, "off").SIMCTL_CHILD_SIMCAM_MIRROR_MODE).toBe("off");
  });

  test("keeps the host environment xcrun needs, and the injection wins over stale values", () => {
    const base = {
      PATH: "/usr/bin:/bin",
      DEVELOPER_DIR: "/Applications/Xcode-beta.app/Contents/Developer",
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: "/stale/other.dylib",
      SIMCTL_CHILD_SIMCAM_SHM_NAME: "/stale",
    };
    const env: Record<string, string | undefined> = cameraLaunchEnv(base, DYLIB, SHM, "off");
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      DEVELOPER_DIR: "/Applications/Xcode-beta.app/Contents/Developer",
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: DYLIB,
      SIMCTL_CHILD_SIMCAM_SHM_NAME: SHM,
      SIMCTL_CHILD_SIMCAM_MIRROR_MODE: "off",
    });
    // The caller's env object is not mutated.
    expect(base.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES).toBe("/stale/other.dylib");
  });

  test("variable names match what the injected dylib reads", () => {
    // The dylib reads these via getenv() after simctl strips SIMCTL_CHILD_.
    const dir = join(import.meta.dir, "../../Sources/SimCameraInjector");
    const text = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(m|h)$/.test(f))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    expect(text.length).toBeGreaterThan(0);
    const env = cameraLaunchEnv({}, DYLIB, SHM, "on");
    for (const key of Object.keys(env)) {
      const guestName = key.replace(/^SIMCTL_CHILD_/, "");
      if (guestName === "DYLD_INSERT_LIBRARIES") continue; // consumed by dyld, not the dylib
      expect({ guestName, read: text.includes(`getenv("${guestName}")`) }).toEqual({ guestName, read: true });
    }
  });
});
