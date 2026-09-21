import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
type Run = (args: string[]) => Promise<string>;
const run: Run = async (args) => (await exec("/usr/bin/xcrun", args, { timeout: 5000 })).stdout;
const key = "com.apple.coredevice.dtuhidd.active";

export function isDeviceHubInputShadowed(output: string): boolean {
  return output.trim() === `${key} 1`;
}

export async function warnDeviceHubInput(udid: string, invoke: Run = run): Promise<void> {
  try {
    if (isDeviceHubInputShadowed(await invoke(["simctl", "spawn", udid, "notifyutil", "-g", key]))) {
      console.warn(`[hid] Device Hub has disconnected legacy input. Run serve-sim repair-input -d ${udid} before using touch or keyboard. Repair restarts SpringBoard and closes running apps.`);
    }
  } catch { /* Older runtimes do not publish this state. */ }
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
