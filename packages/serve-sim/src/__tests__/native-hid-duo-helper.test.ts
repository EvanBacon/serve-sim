import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { launchableHelper } from "../launchable-helper";
import { NativeHid, type NativeHidDeps } from "../native";

// Issue #193 follow-up: resolving the launchable Duo helper runs `codesign`,
// so only an iPhone Duo's HID session may pay for it.
const HARDENED = "CodeDirectory v=20500 size=342 flags=0x10002(adhoc,runtime) hashes=4+2 location=embedded";

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(foldable: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-native-hid-"));
  scratchDirs.push(dir);
  const bundled = join(dir, "serve-sim-duo-hid");
  writeFileSync(bundled, "helper-bytes", { mode: 0o755 });
  const codesignCalls: string[][] = [];
  const codesign = (args: string[]) => {
    codesignCalls.push(args);
    return args[0] === "-d" ? { status: 0, output: HARDENED } : { status: 0, output: "" };
  };
  const native: string[] = [];
  class FakeSimHID {
    constructor(_udid: string, duoHelper: string) { native.push(`new ${duoHelper}`); }
    isFoldable = async () => foldable;
    setDuoHelper = async (path: string) => { native.push(`setDuoHelper ${path}`); };
    pose = async () => { native.push("pose"); return true; };
    orientation = async () => { native.push("orientation"); return true; };
    touch = async () => { native.push("touch"); };
  }
  const deps: NativeHidDeps = {
    SimHID: FakeSimHID as unknown as NativeHidDeps["SimHID"],
    bundledDuoHelper: () => bundled,
    duoHelper: () => launchableHelper(bundled, { codesign, cacheDir: join(dir, "cache") }),
  };
  return { bundled, codesignCalls, native, deps };
}

describe("NativeHid Duo helper", () => {
  test("a non-Duo device never runs codesign", async () => {
    const { bundled, codesignCalls, native, deps } = setup(false);
    const hid = new NativeHid("UDID", deps);
    expect(await hid.orientation(1)).toBe(true);
    expect(codesignCalls).toEqual([]);
    expect(native).toEqual([`new ${bundled}`, "orientation"]);
  });

  test("a Duo points the bridge at the launchable copy before its first guest command", async () => {
    const { bundled, codesignCalls, native, deps } = setup(true);
    const hid = new NativeHid("UDID", deps);
    expect(native).toEqual([`new ${bundled}`]);
    expect(await hid.pose("book", 0)).toBe(true);
    expect(codesignCalls[0]?.[0]).toBe("-d");
    const resolved = native[1]!.replace("setDuoHelper ", "");
    expect(resolved).not.toBe(bundled);
    expect(resolved.endsWith("/serve-sim-duo-hid")).toBe(true);
    expect(native).toEqual([`new ${bundled}`, `setDuoHelper ${resolved}`, "pose"]);
  });

  test("once resolved, guest commands keep their order with touches sent in the same tick", async () => {
    for (const foldable of [false, true]) {
      const { native, deps } = setup(foldable);
      const hid = new NativeHid("UDID", deps);
      await hid.orientation(1);
      native.length = 0;
      await Promise.all([hid.orientation(2), hid.touch("begin", 0.5, 0.5, 100, 100)]);
      expect(native).toEqual(["orientation", "touch"]);
    }
  });
});
