import { realpathSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// The CoreSimulator device set to use instead of Xcode's default, as
// `simctl --set` takes it. Tools that keep simulators in a set of their own
// (device pools, CI runners, Xcode Previews) put them where `simctl list` and
// Simulator.app never look. The variable is how the set reaches what the CLI
// starts (a --detach child, host-action subprocesses) and a dev server that
// embeds the middleware without the CLI.
const DEVICE_SET_ENV = "SERVE_SIM_DEVICE_SET";
const DEFAULT_DEVICE_SET = join(homedir(), "Library/Developer/CoreSimulator/Devices");

let resolved: { path: string | undefined } | undefined;

/**
 * The device set this process targets: an absolute directory, or undefined
 * for Xcode's default set. The first call settles it from `flag` (the CLI's
 * `--device-set`), or else from SERVE_SIM_DEVICE_SET, and writes the result
 * back to that variable for the processes serve-sim starts. Every later call
 * returns the same value, so simctl, the native addon and the state file
 * never disagree. Throws when the value is not an existing directory, or
 * when a flag arrives after the set was settled.
 */
export function resolveDeviceSet(flag?: string): string | undefined {
  if (resolved !== undefined) {
    if (flag !== undefined) throw new Error("--device-set arrived after the device set was settled");
    return resolved.path;
  }
  const fromEnv = process.env[DEVICE_SET_ENV]?.trim();
  let path: string | undefined;
  if (flag !== undefined) path = existingDirectory(flag, "--device-set");
  else if (fromEnv) path = existingDirectory(fromEnv, DEVICE_SET_ENV);
  resolved = { path };
  if (path === undefined) delete process.env[DEVICE_SET_ENV];
  else process.env[DEVICE_SET_ENV] = path;
  return path;
}

function existingDirectory(value: string, source: string): string {
  const trimmed = value.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(1)) : trimmed;
  const path = resolve(expanded);
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {}
  if (trimmed === "" || !isDirectory) {
    throw new Error(`${source}: invalid device set '${value}': expected an existing directory (a simctl --set path).`);
  }
  return path;
}

/**
 * Whether two device-set paths (undefined: Xcode's default set) name one
 * set, symlinks resolved, so `/tmp/set` and `/private/tmp/set` match, and
 * so does Xcode's default folder named explicitly.
 */
export function sameDeviceSet(a: string | undefined, b: string | undefined): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(a ?? DEFAULT_DEVICE_SET) === real(b ?? DEFAULT_DEVICE_SET);
}

/** `xcrun` arguments that run `simctl <args>` against the device set. */
export function simctlArguments(args: readonly string[]): string[] {
  const set = resolveDeviceSet();
  return set === undefined ? ["simctl", ...args] : ["simctl", "--set", set, ...args];
}

/** The directory holding one folder per simulator UDID in the device set. */
export function simulatorDevicesDir(): string {
  return resolveDeviceSet() ?? DEFAULT_DEVICE_SET;
}

/**
 * Arguments for monitoring a boot that serve-sim has already requested.
 *
 * `-b` means "boot if needed". Keeping it out is intentional: after a separate
 * `simctl boot`, Xcode 27 can leave the redundant boot-and-monitor form blocked
 * even though the device is already Booted. This form only monitors the boot
 * transition that serve-sim requested.
 */
export function simctlBootStatusArguments(udid: string): string[] {
  return simctlArguments(["bootstatus", udid]);
}
