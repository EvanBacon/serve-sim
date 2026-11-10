/**
 * Guest helpers run under `simctl spawn`, which points dyld at the simulator
 * runtime through DYLD_ROOT_PATH. A helper re-signed with the hardened runtime
 * (as Electron/notarization packaging does) has dyld drop DYLD_* variables, so
 * it aborts with "DYLD_ROOT_PATH not set for simulator program". Such a helper
 * is copied to a per-user cache and ad-hoc re-signed without the runtime flag.
 */
import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "fs";
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

/** True when dyld would strip the DYLD_* variables `simctl spawn` supplies. */
function dropsDyldEnvironment(codesignOutput: string): boolean {
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/i.exec(codesignOutput)?.[1]?.split(",") ?? [];
  return flags.includes("runtime") && !codesignOutput.includes(DYLD_ENV_ENTITLEMENT);
}

/** `helper`, or a re-signed copy of it that `simctl spawn` can launch. Never throws. */
export function launchableHelper(helper: string, deps: LaunchableHelperDeps = {}): string {
  const codesign = deps.codesign ?? runCodesign;
  try {
    const probe = codesign(["-d", "--verbose=2", "--entitlements", "-", helper]);
    if (probe.status !== 0 || !dropsDyldEnvironment(probe.output)) return helper;

    const { size, mtimeMs } = statSync(helper);
    const uid = process.getuid?.() ?? "user";
    const dir = join(deps.cacheDir ?? join(tmpdir(), `serve-sim-${uid}`, "helpers"), `${size}-${Math.trunc(mtimeMs)}`);
    const copy = join(dir, basename(helper));
    if (existsSync(copy)) return copy;

    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Sign in a private scratch dir and rename into place, so a concurrent
    // process never launches a half-written copy.
    const scratch = mkdtempSync(join(dir, ".tmp-"));
    try {
      const staged = join(scratch, basename(helper));
      copyFileSync(helper, staged);
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
