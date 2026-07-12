import { describe, expect, test } from "bun:test";
import { canShutdownDevice, canStartDevice } from "../client/utils/grid";

describe("Android grid actions", () => {
  test("only offers start for booted Android devices or stopped emulators", () => {
    expect(canStartDevice({ platform: "android", state: "Booted", runtime: "Android" })).toBe(true);
    expect(canStartDevice({ platform: "android", state: "Shutdown", runtime: "Android Emulator" })).toBe(true);
    expect(canStartDevice({ platform: "android", state: "Offline", runtime: "Android" })).toBe(false);
    expect(canStartDevice({ platform: "android", state: "Unauthorized", runtime: "Android" })).toBe(false);
    expect(canStartDevice({ platform: "ios", state: "Shutdown", runtime: "iOS-18-0" })).toBe(true);
  });

  test("only exposes shutdown for Android emulators", () => {
    expect(canShutdownDevice("android", "emulator-5554")).toBe(true);
    expect(canShutdownDevice("android", "ZY22")).toBe(false);
    expect(canShutdownDevice("ios", "00000000-0000-0000-0000-000000000000")).toBe(true);
  });
});
