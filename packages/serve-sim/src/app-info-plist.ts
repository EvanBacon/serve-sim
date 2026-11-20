import { execFile } from "child_process";
import { lstatSync } from "fs";
import { join } from "path";
import { simctlArguments } from "./simctl";

// Reads an installed simulator app's Info.plist as JSON. Shared by the
// `appDetails` host action and `serve-sim permissions list` (and anything
// else that needs plist keys, e.g. CFBundleURLTypes for deep links).

interface PlistRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type PlistRunner = (file: string, args: string[]) => Promise<PlistRunResult>;

function execFileRunner(file: string, args: string[]): Promise<PlistRunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        exitCode: err ? (typeof code === "number" ? code : 127) : 0,
      });
    });
  });
}

/** `.app` path of an installed app, or null when it isn't installed. */
export async function appBundlePath(
  udid: string,
  bundleId: string,
  run: PlistRunner = execFileRunner,
): Promise<{ path: string } | { error: string }> {
  const r = await run("xcrun", simctlArguments(["get_app_container", udid, bundleId, "app"]));
  if (r.exitCode !== 0) return { error: r.stderr.trim() || "App not found on simulator" };
  const path = r.stdout.trim();
  return path ? { path } : { error: "Empty app path" };
}

/**
 * Info.plist of the bundle at `appPath`, or null if it is missing, not a
 * regular file (a symlink can't point plutil at an arbitrary path), or not
 * convertible to JSON.
 */
export async function readInfoPlistAt(
  appPath: string,
  run: PlistRunner = execFileRunner,
): Promise<Record<string, unknown> | null> {
  const plistPath = join(appPath, "Info.plist");
  let isFile = false;
  try { isFile = lstatSync(plistPath).isFile(); } catch {}
  if (!isFile) return null;
  const r = await run("plutil", ["-convert", "json", "-o", "-", plistPath]);
  if (r.exitCode !== 0) return null;
  try {
    const info: unknown = JSON.parse(r.stdout);
    return info && typeof info === "object" && !Array.isArray(info) ? (info as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Info.plist of an installed app, or null when it can't be read. */
export async function readAppInfoPlist(
  udid: string,
  bundleId: string,
  run: PlistRunner = execFileRunner,
): Promise<Record<string, unknown> | null> {
  const app = await appBundlePath(udid, bundleId, run);
  return "path" in app ? readInfoPlistAt(app.path, run) : null;
}
