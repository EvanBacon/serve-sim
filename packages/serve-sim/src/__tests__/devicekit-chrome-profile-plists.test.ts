import * as realChildProcess from "child_process";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, mock, test } from "bun:test";

// Count plutil spawns while delegating to the real implementation, so the
// module mock is harmless to any other test sharing this process.
const plutilArgs: string[][] = [];
const realExecFileSync = realChildProcess.execFileSync;
mock.module("child_process", () => ({
  ...realChildProcess,
  execFileSync: (file: string, args: string[], options: unknown) => {
    if (file === "plutil") plutilArgs.push(args);
    return (realExecFileSync as (...a: unknown[]) => unknown)(file, args, options);
  },
}));

const {
  primePlistCache,
  primeDeviceProfilePlists,
  resolveDeviceDisplays,
  resolveDeviceKitChrome,
  resolveDevicePlaceholderAsset,
} = await import("../devicekit-chrome");

const DEVICE_TYPES_ROOT = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes";

describe("primePlistCache", () => {
  test("stores one batch result per path", () => {
    const cache = new Map<string, Record<string, unknown> | null>();
    const batches: string[][] = [];
    primePlistCache(["/a.plist", "/b.plist"], (paths) => {
      batches.push(paths);
      return [{ a: 1 }, { b: 2 }];
    }, cache);
    expect(batches).toEqual([["/a.plist", "/b.plist"]]);
    expect([...cache]).toEqual([["/a.plist", { a: 1 }], ["/b.plist", { b: 2 }]]);
  });

  test("leaves the cache untouched when the batch fails or is incomplete", () => {
    const cache = new Map<string, Record<string, unknown> | null>();
    primePlistCache(["/a.plist", "/b.plist"], () => null, cache);
    primePlistCache(["/a.plist", "/b.plist"], () => [{ a: 1 }], cache);
    expect(cache.size).toBe(0);
  });

  test("doesn't spawn for an empty path list", () => {
    primePlistCache([], () => {
      throw new Error("batch should not run with no paths");
    }, new Map());
  });
});

// Every device type that has a profile.plist, as the grid would list them.
function installedDeviceTypes(): { name: string }[] {
  return readdirSync(DEVICE_TYPES_ROOT)
    .filter((entry) => entry.endsWith(".simdevicetype"))
    .map((entry) => ({ name: entry.replace(/\.simdevicetype$/, "") }))
    .filter(({ name }) =>
      existsSync(join(DEVICE_TYPES_ROOT, `${name}.simdevicetype`, "Contents", "Resources", "profile.plist")),
    )
    .slice(0, 12);
}

const profilePlistSpawns = () =>
  plutilArgs.filter((args) =>
    args.some((arg) => /\.simdevicetype\/Contents\/Resources\/(profile|capabilities)\.plist$/.test(arg)),
  );

describe.skipIf(!existsSync(DEVICE_TYPES_ROOT))("grid page resolution on this host", () => {
  test("a cold page reads every profile and capabilities plist in one plutil call", () => {
    const devices = installedDeviceTypes();
    expect(devices.length).toBeGreaterThan(1);
    plutilArgs.length = 0;
    primeDeviceProfilePlists(devices);
    for (const d of devices) {
      resolveDeviceDisplays(d);
      resolveDeviceKitChrome(d);
      resolveDevicePlaceholderAsset(d);
    }
    // Previously two synchronous plutil spawns per device type (capabilities +
    // profile), ~120 ms of event-loop stall on the first /grid/api.
    expect(profilePlistSpawns().length).toBe(1);
  });

  test("an already-primed page doesn't spawn plutil again", () => {
    const devices = installedDeviceTypes();
    plutilArgs.length = 0;
    primeDeviceProfilePlists(devices);
    expect(profilePlistSpawns().length).toBe(0);
  });
});
