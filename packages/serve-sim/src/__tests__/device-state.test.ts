import { describe, expect, test } from "bun:test";
import {
  LOCKSTATE_KEY,
  parseNotifyState,
  readDeviceState,
  type DeviceStateDeps,
} from "../device-state";

const UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

function deps(overrides: Partial<DeviceStateDeps> = {}): DeviceStateDeps {
  return {
    run: async () => `${LOCKSTATE_KEY} 0`,
    frontmost: async () => JSON.stringify({ bundleId: "com.apple.springboard", pid: 42 }),
    ...overrides,
  };
}

describe("parseNotifyState", () => {
  test("parses '<key> N' output", () => {
    expect(parseNotifyState(`${LOCKSTATE_KEY} 1`, LOCKSTATE_KEY)).toBe(1);
    expect(parseNotifyState(`${LOCKSTATE_KEY} 0`, LOCKSTATE_KEY)).toBe(0);
  });

  test("finds the key among other lines", () => {
    const out = `something else\n${LOCKSTATE_KEY} 1\ntrailing`;
    expect(parseNotifyState(out, LOCKSTATE_KEY)).toBe(1);
  });

  test("returns null for missing key or malformed value", () => {
    expect(parseNotifyState("", LOCKSTATE_KEY)).toBeNull();
    expect(parseNotifyState("other.key 1", LOCKSTATE_KEY)).toBeNull();
    expect(parseNotifyState(`${LOCKSTATE_KEY} nope`, LOCKSTATE_KEY)).toBeNull();
    expect(parseNotifyState(LOCKSTATE_KEY, LOCKSTATE_KEY)).toBeNull();
  });
});

describe("readDeviceState", () => {
  test("reports locked=true when SpringBoard says 1", async () => {
    const state = await readDeviceState(UDID, deps({ run: async () => `${LOCKSTATE_KEY} 1` }));
    expect(state).toEqual({ locked: true, frontmostApp: "com.apple.springboard" });
  });

  test("reports locked=false when SpringBoard says 0", async () => {
    const state = await readDeviceState(UDID, deps());
    expect(state).toEqual({ locked: false, frontmostApp: "com.apple.springboard" });
  });

  test("passes the udid to notifyutil via simctl spawn", async () => {
    const calls: string[][] = [];
    await readDeviceState(UDID, deps({
      run: async (file, args) => {
        calls.push([file, ...args]);
        return `${LOCKSTATE_KEY} 0`;
      },
    }));
    expect(calls).toEqual([
      ["xcrun", "simctl", "spawn", UDID, "notifyutil", "-g", LOCKSTATE_KEY],
    ]);
  });

  test("locked is null when notifyutil fails or prints garbage", async () => {
    const failed = await readDeviceState(UDID, deps({
      run: async () => { throw new Error("Invalid device state"); },
    }));
    expect(failed.locked).toBeNull();

    const garbled = await readDeviceState(UDID, deps({ run: async () => "no such key" }));
    expect(garbled.locked).toBeNull();
  });

  test("frontmostApp is null when the AX probe fails", async () => {
    const state = await readDeviceState(UDID, deps({
      frontmost: async () => { throw new Error("ax unavailable"); },
    }));
    expect(state).toEqual({ locked: false, frontmostApp: null });
  });

  test("frontmostApp is null for malformed or empty probe output", async () => {
    const malformed = await readDeviceState(UDID, deps({ frontmost: async () => "not json" }));
    expect(malformed.frontmostApp).toBeNull();

    const empty = await readDeviceState(UDID, deps({ frontmost: async () => "{}" }));
    expect(empty.frontmostApp).toBeNull();
  });

  test("one failing probe does not blank the other", async () => {
    const state = await readDeviceState(UDID, deps({
      run: async () => { throw new Error("spawn failed"); },
    }));
    expect(state).toEqual({ locked: null, frontmostApp: "com.apple.springboard" });
  });
});
