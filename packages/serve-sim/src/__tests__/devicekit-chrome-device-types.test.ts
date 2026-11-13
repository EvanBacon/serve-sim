import * as realChildProcess from "child_process";
import { existsSync, readdirSync } from "fs";
import { basename, join } from "path";
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
  deviceTypeNameMapFromBundles,
  parseConcatenatedJsonObjects,
  buildDeviceTypeNameMap,
} = await import("../devicekit-chrome");

const DEVICE_TYPES_ROOT = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes";

describe("parseConcatenatedJsonObjects", () => {
  test("splits plutil's back-to-back JSON objects", () => {
    expect(parseConcatenatedJsonObjects('{"a":1}{"b":[1,{"c":2}]}\n{"d":"x"}')).toEqual([
      { a: 1 },
      { b: [1, { c: 2 }] },
      { d: "x" },
    ]);
  });

  test("ignores braces and escaped quotes inside strings", () => {
    expect(parseConcatenatedJsonObjects('{"s":"}{\\"]["}{"t":"\\\\"}')).toEqual([
      { s: '}{"][' },
      { t: "\\" },
    ]);
  });

  test("rejects streams that aren't a clean object sequence", () => {
    expect(parseConcatenatedJsonObjects('{"a":1}{"b":')).toBeNull();
    expect(parseConcatenatedJsonObjects('{"a":1}}')).toBeNull();
    expect(parseConcatenatedJsonObjects('{"a":1} junk')).toBeNull();
    expect(parseConcatenatedJsonObjects("[1]")).toBeNull();
  });

  test("returns an empty list for empty output", () => {
    expect(parseConcatenatedJsonObjects("")).toEqual([]);
  });
});

describe("deviceTypeNameMapFromBundles", () => {
  const entries = ["iPhone 17.simdevicetype", "Odd.simdevicetype"];
  const path = (entry: string) => `/types/${entry}/Contents/Info.plist`;

  test("reads every Info.plist in one batch", () => {
    const batches: string[][] = [];
    const map = deviceTypeNameMapFromBundles(
      entries,
      path,
      (paths) => {
        batches.push(paths);
        return [
          { CFBundleIdentifier: "id.iphone17", CFBundleName: "iPhone 17" },
          { CFBundleIdentifier: "id.odd" },
        ];
      },
      () => {
        throw new Error("per-file read should not run when the batch succeeds");
      },
    );
    expect(batches).toEqual([entries.map(path)]);
    // A missing CFBundleName still falls back to the bundle's basename.
    expect([...map]).toEqual([
      ["id.iphone17", "iPhone 17"],
      ["id.odd", "Odd"],
    ]);
  });

  test("falls back to per-file reads when the batch is incomplete", () => {
    const single: string[] = [];
    const map = deviceTypeNameMapFromBundles(
      entries,
      path,
      () => [{ CFBundleIdentifier: "id.iphone17", CFBundleName: "iPhone 17" }],
      (p) => {
        single.push(p);
        return p.includes("Odd") ? null : { CFBundleIdentifier: "id.iphone17", CFBundleName: "iPhone 17" };
      },
    );
    expect(single).toEqual(entries.map(path));
    expect([...map]).toEqual([["id.iphone17", "iPhone 17"]]);
  });

  test("falls back to per-file reads when the batch fails", () => {
    const map = deviceTypeNameMapFromBundles(
      entries,
      path,
      () => null,
      (p) => ({ CFBundleIdentifier: p.includes("Odd") ? "id.odd" : "id.iphone17" }),
    );
    expect([...map]).toEqual([
      ["id.iphone17", "iPhone 17"],
      ["id.odd", "Odd"],
    ]);
  });
});

describe.skipIf(!existsSync(DEVICE_TYPES_ROOT))("device type lookup on this host", () => {
  test("building the device type map doesn't spawn plutil per installed bundle", () => {
    plutilArgs.length = 0;
    const map = buildDeviceTypeNameMap();
    const infoPlistSpawns = plutilArgs.filter((args) =>
      args.some((arg) => arg.endsWith(".simdevicetype/Contents/Info.plist")),
    );
    // Previously one spawn per .simdevicetype (~130), which blocked the event
    // loop carrying the MJPEG stream for 0.4–2 s on the first /grid/api.
    expect(infoPlistSpawns.length).toBe(1);
    expect(map.size).toBeGreaterThan(0);
  });

  test("the batched map matches per-file reads", () => {
    const batched = buildDeviceTypeNameMap();
    const perFile = new Map<string, string>();
    for (const entry of readdirSync(DEVICE_TYPES_ROOT)) {
      if (!entry.endsWith(".simdevicetype")) continue;
      const json = realExecFileSync(
        "plutil",
        ["-convert", "json", "-o", "-", join(DEVICE_TYPES_ROOT, entry, "Contents", "Info.plist")],
        { encoding: "utf-8" },
      );
      const info = JSON.parse(json) as Record<string, unknown>;
      if (typeof info.CFBundleIdentifier !== "string") continue;
      perFile.set(
        info.CFBundleIdentifier,
        typeof info.CFBundleName === "string" ? info.CFBundleName : basename(entry, ".simdevicetype"),
      );
    }
    expect(batched).toEqual(perFile);
  });
});
