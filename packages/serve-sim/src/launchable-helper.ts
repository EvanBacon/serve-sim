/**
 * Guest helpers run under `simctl spawn`, which points dyld at the simulator
 * runtime through DYLD_ROOT_PATH. A helper re-signed with the hardened runtime
 * (as Electron/notarization packaging does) has dyld drop DYLD_* variables, so
 * it aborts with "DYLD_ROOT_PATH not set for simulator program". Such a helper
 * is copied to a per-user cache and ad-hoc re-signed without the runtime flag.
 *
 * The cache may sit in a shared `/tmp` (when TMPDIR is unset), and its copy is
 * executed, so every directory on the way and the copy itself must be owned by
 * this user and writable by nobody else; otherwise the bundled helper is used.
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, type Stats } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

const DYLD_ENV_ENTITLEMENT = "com.apple.security.cs.allow-dyld-environment-variables";

export interface LaunchableHelperDeps {
  /** Runs `codesign` with `args`; `output` is stdout and stderr combined. */
  codesign?: (args: string[]) => { status: number | null; output: string };
  /** Where re-signed copies live. */
  cacheDir?: string;
}

function runCodesign(args: string[]) {
  const result = spawnSync("/usr/bin/codesign", args, { encoding: "utf8", timeout: 10_000 });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * True when the entitlements grant DYLD_* variables. `codesign` prints them as
 * `[Key] <name>` / `[Value]` / `[Bool] true`, or as XML `<key>` / `<true/>`.
 */
function allowsDyldEnvironment(codesignOutput: string): boolean {
  const at = codesignOutput.indexOf(DYLD_ENV_ENTITLEMENT);
  if (at < 0) return false;
  // Only the value directly after the key counts, never a later key's.
  const value = /^\s*(?:\[Value\]\s*\[Bool\]\s*(\w+)|<\/key>\s*<(\w+)\s*\/>)/.exec(codesignOutput.slice(at + DYLD_ENV_ENTITLEMENT.length));
  return (value?.[1] ?? value?.[2]) === "true";
}

/** True when dyld would strip the DYLD_* variables `simctl spawn` supplies. */
function dropsDyldEnvironment(codesignOutput: string): boolean {
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/i.exec(codesignOutput)?.[1]?.split(",") ?? [];
  return flags.includes("runtime") && !allowsDyldEnvironment(codesignOutput);
}

/** True when only this user could have written the entry at `stats`. */
function privateTo(stats: Stats, isType: (s: Stats) => boolean): boolean {
  const uid = process.getuid?.();
  return isType(stats) && (uid === undefined || stats.uid === uid) && (stats.mode & 0o022) === 0;
}

/** Creates `dir` if missing; throws unless it is a private, non-symlinked directory. */
function ensurePrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!privateTo(lstatSync(dir), (s) => s.isDirectory())) throw new Error(`Refusing to use ${dir}`);
}

/** The private cached copy at `copy`, `undefined` when absent; throws when not private. */
function existingCopy(copy: string): string | undefined {
  let stats: Stats;
  try {
    stats = lstatSync(copy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!privateTo(stats, (s) => s.isFile())) throw new Error(`Refusing to run ${copy}`);
  return copy;
}

/** `helper`, or a re-signed copy of it that `simctl spawn` can launch. Never throws. */
export function launchableHelper(helper: string, deps: LaunchableHelperDeps = {}): string {
  const codesign = deps.codesign ?? runCodesign;
  try {
    const probe = codesign(["-d", "--verbose=2", "--entitlements", "-", helper]);
    if (probe.status !== 0 || !dropsDyldEnvironment(probe.output)) return helper;

    // Keyed by content, so a different build never reuses another's copy.
    const digest = createHash("sha256").update(readFileSync(helper)).digest("hex").slice(0, 32);
    const userRoot = join(tmpdir(), `serve-sim-${process.getuid?.() ?? "user"}`);
    const dirs = deps.cacheDir ? [deps.cacheDir] : [userRoot, join(userRoot, "helpers")];
    const dir = join(dirs[dirs.length - 1]!, digest);
    for (const d of [...dirs, dir]) ensurePrivateDir(d);
    const copy = join(dir, basename(helper));
    const cached = existingCopy(copy);
    if (cached) return cached;

    // Sign in a private scratch dir and rename into place, so a concurrent
    // process never launches a half-written copy.
    const scratch = mkdtempSync(join(dir, ".tmp-"));
    try {
      const staged = join(scratch, basename(helper));
      copyFileSync(helper, staged);
      chmodSync(staged, 0o755); // the source's mode may be group-writable
      if (codesign(["-f", "-s", "-", staged]).status !== 0) return helper;
      renameSync(staged, copy);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    return copy;
  } catch {
    return helper;
  }
}
