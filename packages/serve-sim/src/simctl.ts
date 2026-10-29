import { statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

/**
 * CoreSimulator device set to use instead of Xcode's default
 * (`~/Library/Developer/CoreSimulator/Devices`), as `simctl --set` takes it.
 * Tools that keep simulators in a set of their own (device pools, CI
 * runners, Xcode Previews) put them where `simctl list` and Simulator.app
 * never look. The CLI hands `--device-set` to the in-process capture, to a
 * --detach child and to host RPCs through the environment, like the auth
 * token.
 */
export const DEVICE_SET_ENV = "SERVE_SIM_DEVICE_SET";

/** The configured device set's path, or undefined for Xcode's default set. */
export function deviceSetFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[DEVICE_SET_ENV];
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/** Resolve a `--device-set` value to an absolute directory. Throws when it is not one. */
export function parseDeviceSetPath(value: string, cwd: string = process.cwd()): string {
  const trimmed = value.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(1)) : trimmed;
  const path = resolve(cwd, expanded);
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {}
  if (trimmed === "" || !isDirectory) {
    throw new Error(`Invalid device set '${value}': expected an existing directory (a simctl --set path).`);
  }
  return path;
}

/**
 * Give a `SERVE_SIM_DEVICE_SET` from the caller's environment the flag's
 * checks, resolved in place, so every command and helper reads one absolute
 * path. Throws when it is not a directory.
 */
export function normalizeDeviceSetEnv(env: NodeJS.ProcessEnv = process.env): void {
  const raw = deviceSetFromEnv(env);
  if (raw === undefined) {
    delete env[DEVICE_SET_ENV];
    return;
  }
  try {
    env[DEVICE_SET_ENV] = parseDeviceSetPath(raw);
  } catch (error) {
    throw new Error(`${DEVICE_SET_ENV}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Hand `--device-set` to everything this process starts; absent leaves the environment alone. */
export function applyDeviceSetOption(path: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (path !== undefined) env[DEVICE_SET_ENV] = path;
}

/** `xcrun` arguments that run `simctl <args>` against the configured device set. */
export function simctlArguments(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const set = deviceSetFromEnv(env);
  return set === undefined ? ["simctl", ...args] : ["simctl", "--set", set, ...args];
}

/** The directory holding one folder per simulator UDID in the configured set. */
export function simulatorDevicesDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return deviceSetFromEnv(env) ?? join(home, "Library/Developer/CoreSimulator/Devices");
}

/**
 * Arguments for monitoring a boot that serve-sim has already requested.
 *
 * `-b` means "boot if needed". Keeping it out is intentional: after a separate
 * `simctl boot`, Xcode 27 can leave the redundant boot-and-monitor form blocked
 * even though the device is already Booted. This form only monitors the boot
 * transition that serve-sim requested.
 */
export function simctlBootStatusArguments(udid: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return simctlArguments(["bootstatus", udid], env);
}
