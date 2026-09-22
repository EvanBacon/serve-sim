import { expect, test } from "bun:test";
import { isDeviceHubInputShadowed, repairDeviceHubInput } from "../device-hub-input";

test("Device Hub input detection requires its exact active state", () => {
  expect(isDeviceHubInputShadowed("com.apple.coredevice.dtuhidd.active 1\n")).toBe(true);
  for (const value of ["", "com.apple.coredevice.dtuhidd.active 0", "another.key 1", "com.apple.coredevice.dtuhidd.active 10"]) {
    expect(isDeviceHubInputShadowed(value)).toBe(false);
  }
});

test("input recovery clears suppression before restarting the guest service", async () => {
  const calls: string[][] = [];
  expect(await repairDeviceHubInput("DEVICE", async (args) => {
    calls.push(args);
    return "com.apple.coredevice.dtuhidd.active 1";
  })).toBe(true);
  expect(calls.map((args) => args.slice(3))).toEqual([
    ["notifyutil", "-g", "com.apple.coredevice.dtuhidd.active"],
    ["notifyutil", "-s", "com.apple.coredevice.dtuhidd.active", "0"],
    ["launchctl", "kickstart", "-k", "system/com.apple.backboardd"],
  ]);
});

test("input recovery leaves an unshadowed simulator running", async () => {
  let calls = 0;
  expect(await repairDeviceHubInput("DEVICE", async () => {
    calls++;
    return "com.apple.coredevice.dtuhidd.active 0";
  })).toBe(false);
  expect(calls).toBe(1);
});

test("a failed suppression reset never restarts SpringBoard", async () => {
  let calls = 0;
  await expect(repairDeviceHubInput("DEVICE", async () => {
    if (++calls === 2) throw new Error("reset failed");
    return "com.apple.coredevice.dtuhidd.active 1";
  })).rejects.toThrow("reset failed");
  expect(calls).toBe(2);
});
