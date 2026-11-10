import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync, type execFile, type spawn } from "child_process";
import { EventEmitter } from "events";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import { DuoStateMonitor } from "../duo-state";
import { launchableHelper } from "../launchable-helper";

// Issue #193: a helper re-signed with the hardened runtime (Electron/notarized
// bundles) aborts under `simctl spawn` with "DYLD_ROOT_PATH not set".
const HARDENED = "CodeDirectory v=20500 size=342 flags=0x10002(adhoc,runtime) hashes=4+2 location=embedded";
const LINKER_SIGNED = "CodeDirectory v=20400 size=342 flags=0x20002(adhoc,linker-signed) hashes=8+0 location=embedded";
const ENTITLED = `${HARDENED}\n[Dict]\n\t[Key] com.apple.security.cs.allow-dyld-environment-variables\n\t[Value]\n\t\t[Bool] true`;

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-launchable-"));
  scratchDirs.push(dir);
  return dir;
}

/** A helper on disk plus a fake codesign that reports `probe` and records calls. */
function fixture(probe: { status: number | null; output: string }, signStatus = 0) {
  const dir = scratch();
  const helper = join(dir, "serve-sim-duo-hid");
  writeFileSync(helper, "helper-bytes", { mode: 0o755 });
  const calls: string[][] = [];
  const codesign = (args: string[]) => {
    calls.push(args);
    return args[0] === "-d" ? probe : { status: signStatus, output: "" };
  };
  return { helper, calls, codesign, cacheDir: join(dir, "cache") };
}

describe("launchableHelper", () => {
  test("re-signs a hardened helper's cached copy without the runtime flag", () => {
    const { helper, calls, codesign, cacheDir } = fixture({ status: 0, output: HARDENED });
    const resolved = launchableHelper(helper, { codesign, cacheDir });

    expect(resolved).not.toBe(helper);
    expect(resolved.startsWith(cacheDir)).toBe(true);
    expect(resolved.endsWith("/serve-sim-duo-hid")).toBe(true);
    expect(readFileSync(resolved, "utf8")).toBe("helper-bytes");
    const sign = calls.find((args) => args[0] === "-f")!;
    expect(sign.slice(0, 3)).toEqual(["-f", "-s", "-"]);
    expect(sign).not.toContain("--options");

    // A second process reuses the copy instead of signing again.
    calls.length = 0;
    expect(launchableHelper(helper, { codesign, cacheDir })).toBe(resolved);
    expect(calls.some((args) => args[0] === "-f")).toBe(false);
  });

  test("a changed helper gets a fresh copy", () => {
    const { helper, codesign, cacheDir } = fixture({ status: 0, output: HARDENED });
    const first = launchableHelper(helper, { codesign, cacheDir });
    writeFileSync(helper, "updated-helper-bytes");
    const second = launchableHelper(helper, { codesign, cacheDir });
    expect(second).not.toBe(first);
    expect(readFileSync(second, "utf8")).toBe("updated-helper-bytes");
  });

  test("keeps the bundled helper when it already launches", () => {
    // npm's linker-signed helper, and a hardened one entitled to keep DYLD_* variables.
    for (const output of [LINKER_SIGNED, ENTITLED, "CodeDirectory flags=0x2(adhoc) runtime-version"]) {
      const { helper, calls, codesign, cacheDir } = fixture({ status: 0, output });
      expect(launchableHelper(helper, { codesign, cacheDir })).toBe(helper);
      expect(calls).toHaveLength(1);
    }
  });

  test("falls back to the bundled helper when codesign fails", () => {
    const unsigned = fixture({ status: 1, output: "code object is not signed at all" });
    expect(launchableHelper(unsigned.helper, unsigned)).toBe(unsigned.helper);

    const missing = fixture({ status: null, output: "" }); // codesign not installed
    expect(launchableHelper(missing.helper, missing)).toBe(missing.helper);

    const signFails = fixture({ status: 0, output: HARDENED }, 1);
    expect(launchableHelper(signFails.helper, signFails)).toBe(signFails.helper);

    const throws = fixture({ status: 0, output: HARDENED });
    expect(launchableHelper(throws.helper, { codesign: () => { throw new Error("boom"); }, cacheDir: throws.cacheDir })).toBe(throws.helper);
  });

  test("the Duo hinge reader spawns the resolved copy inside the simulator", () => {
    const { helper, codesign, cacheDir } = fixture({ status: 0, output: HARDENED });
    const resolved = launchableHelper(helper, { codesign, cacheDir });
    const spawned: string[][] = [];
    const fakeChild = () => Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    });
    const monitor = new DuoStateMonitor("UDID", () => {}, {
      duoHelper: () => resolved,
      spawn: ((_command: string, args: string[]) => { spawned.push(args); return fakeChild(); }) as unknown as typeof spawn,
      execFile: (() => fakeChild()) as unknown as typeof execFile,
    });
    monitor.close();
    expect(spawned).toContainEqual(["simctl", "spawn", "UDID", resolved, "watch-angle"]);
  });
});

// Real codesign: sign a copy the way Electron packaging does, then resolve it.
const BUILT_HELPER = join(import.meta.dir, "../../dist/simduo/serve-sim-duo-hid");
const hasCodesign = process.platform === "darwin" && existsSync("/usr/bin/codesign");

describe.skipIf(!hasCodesign)("launchableHelper (codesign)", () => {
  const flags = (path: string) => spawnSync("/usr/bin/codesign", ["-d", "--verbose=2", path], { encoding: "utf8" }).stderr;

  test("a hardened-runtime helper resolves to a copy without the runtime flag", () => {
    const dir = scratch();
    const helper = join(dir, "serve-sim-duo-hid");
    copyFileSync(existsSync(BUILT_HELPER) ? BUILT_HELPER : "/usr/bin/true", helper);
    expect(spawnSync("/usr/bin/codesign", ["-f", "-s", "-", "--options", "runtime", helper]).status).toBe(0);
    expect(flags(helper)).toMatch(/flags=0x[0-9a-f]+\([^)]*runtime/);

    const resolved = launchableHelper(helper, { cacheDir: join(dir, "cache") });
    expect(resolved).not.toBe(helper);
    expect(flags(resolved)).toMatch(/flags=0x[0-9a-f]+\(adhoc/);
    expect(flags(resolved)).not.toMatch(/flags=0x[0-9a-f]+\([^)]*runtime/);
    expect(spawnSync("/usr/bin/codesign", ["--verify", resolved]).status).toBe(0);
  });
});
