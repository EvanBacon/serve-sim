import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
type Run = (args: string[]) => Promise<string>;
const run: Run = async (args) => (await exec("/usr/bin/xcrun", args, { timeout: 5000 })).stdout;
const key = "com.apple.coredevice.dtuhidd.active";

export function isDeviceHubInputShadowed(output: string): boolean {
  return output.trim() === `${key} 1`;
}

/** Warns when shadowed. Resolves the guest flag, or undefined when the runtime does not publish it. */
export async function warnDeviceHubInput(udid: string, invoke: Run = run): Promise<boolean | undefined> {
  try {
    const shadowed = isDeviceHubInputShadowed(await invoke(["simctl", "spawn", udid, "notifyutil", "-g", key]));
    if (shadowed) {
      console.warn(`[hid] Device Hub has disconnected legacy input. Run serve-sim repair-input -d ${udid} before using touch or keyboard. Repair restarts SpringBoard and closes running apps.`);
    }
    return shadowed;
  } catch { return undefined; /* Older runtimes do not publish this state. */ }
}

/** Raw guest flag for diagnostics: true/false, or null when unreadable. */
export async function readDeviceHubInputShadowed(udid: string, invoke: Run = run): Promise<boolean | null> {
  try {
    return isDeviceHubInputShadowed(await invoke(["simctl", "spawn", udid, "notifyutil", "-g", key]));
  } catch {
    return null;
  }
}

/** Explicit recovery only: restarting backboardd also terminates running apps. */
export async function repairDeviceHubInput(udid: string, invoke: Run = run): Promise<boolean> {
  const args = ["simctl", "spawn", udid];
  if (!isDeviceHubInputShadowed(await invoke([...args, "notifyutil", "-g", key]))) return false;
  // Order is essential: the replacement backboardd must start with state zero.
  await invoke([...args, "notifyutil", "-s", key, "0"]);
  await invoke([...args, "launchctl", "kickstart", "-k", "system/com.apple.backboardd"]);
  return true;
}
