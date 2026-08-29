import { execFile } from "child_process";
import { findBootedDevice, resolveDevice } from "./device";
import { axFrontmostAsync } from "./native";

// ─── `serve-sim state` ───
//
// One-shot device-state probe for agents driving a sim headless (#137):
// whether SpringBoard considers the device locked, and which app is frontmost.
// Standalone like `serve-sim ui` — reads go through `simctl spawn notifyutil`
// and the in-process AX addon, so no serve-sim server needs to be running.

export const LOCKSTATE_KEY = "com.apple.springboard.lockstate";

export interface DeviceState {
  /** SpringBoard lock state, or null when it can't be read. */
  locked: boolean | null;
  /** Bundle id of the frontmost app, or null when the AX probe fails. */
  frontmostApp: string | null;
}

/** Injectable backends so tests can run without a simulator. */
export interface DeviceStateDeps {
  /** Run `file args…` and resolve with trimmed stdout. */
  run: (file: string, args: string[]) => Promise<string>;
  /** Frontmost-app probe returning `{ bundleId, pid }` JSON (native addon). */
  frontmost: (udid: string) => Promise<string>;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf-8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

const defaultDeps: DeviceStateDeps = { run, frontmost: axFrontmostAsync };

/**
 * Parse `notifyutil -g <key>` output ("<key> N") into its integer state, or
 * null when the output doesn't match (e.g. notifyutil errored or the key line
 * is missing).
 */
export function parseNotifyState(output: string, key: string): number | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(key)) continue;
    const value = trimmed.slice(key.length).trim();
    if (/^\d+$/.test(value)) return Number(value);
  }
  return null;
}

async function readLocked(udid: string, deps: DeviceStateDeps): Promise<boolean | null> {
  try {
    const out = await deps.run("xcrun", ["simctl", "spawn", udid, "notifyutil", "-g", LOCKSTATE_KEY]);
    const state = parseNotifyState(out, LOCKSTATE_KEY);
    return state == null ? null : state !== 0;
  } catch {
    return null;
  }
}

async function readFrontmostApp(udid: string, deps: DeviceStateDeps): Promise<string | null> {
  try {
    const info = JSON.parse(await deps.frontmost(udid)) as { bundleId?: unknown };
    return typeof info.bundleId === "string" && info.bundleId.length > 0 ? info.bundleId : null;
  } catch {
    return null;
  }
}

/** Probe the device and report its state; fields that can't be read are null. */
export function readDeviceState(udid: string, deps: DeviceStateDeps = defaultDeps): Promise<DeviceState> {
  return Promise.all([readLocked(udid, deps), readFrontmostApp(udid, deps)]).then(
    ([locked, frontmostApp]) => ({ locked, frontmostApp }),
  );
}

/** CLI entry (`serve-sim state [-d udid]`): print the state as one JSON object. */
export async function deviceState(deviceArg?: string): Promise<void> {
  const udid = deviceArg ? resolveDevice(deviceArg) : findBootedDevice();
  if (!udid) {
    console.error("No booted simulator found. Boot one or pass -d <udid>.");
    process.exit(1);
  }
  console.log(JSON.stringify(await readDeviceState(udid)));
}
