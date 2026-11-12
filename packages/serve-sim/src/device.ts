import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { simctlArguments } from "./simctl";

const execFileAsync = promisify(execFile);

/**
 * UDID of a booted simulator, or null if none is booted. Prefers an iOS device
 * — a machine may also have a booted watchOS/tvOS sim, which `serve-sim`'s
 * tooling doesn't target.
 */
export function findBootedDevice(): string | null {
  try {
    const output = execFileSync("xcrun", simctlArguments(["list", "devices", "booted", "-j"]), { encoding: "utf-8" });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
    };
    let fallback: string | null = null;
    for (const [runtime, devices] of Object.entries(data.devices)) {
      for (const device of devices) {
        if (device.state !== "Booted") continue;
        if (/iOS/i.test(runtime)) return device.udid;
        fallback ??= device.udid;
      }
    }
    return fallback;
  } catch {}
  return null;
}

/** Whether the selected device set lists `udid`, in any case, as simctl reads it. */
export function isInDeviceSet(udid: string): boolean {
  try {
    const output = execFileSync("xcrun", simctlArguments(["list", "devices", "-j"]), { encoding: "utf-8" });
    const data = JSON.parse(output) as { devices: Record<string, Array<{ udid: string }>> };
    return Object.values(data.devices).some((devices) => devices.some((device) => device.udid.toUpperCase() === udid.toUpperCase()));
  } catch {
    return false;
  }
}

/**
 * Resolve a device name or UDID to a UDID. A UDID is returned as-is; a name is
 * matched case-insensitively against `simctl list devices`. Exits the process
 * with a clear error when the name cannot be resolved.
 */
export function resolveDevice(nameOrUDID: string): string {
  if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(nameOrUDID)) {
    return nameOrUDID;
  }
  try {
    const output = execFileSync("xcrun", simctlArguments(["list", "devices", "-j"]), { encoding: "utf-8" });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
    };
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.name.toLowerCase() === nameOrUDID.toLowerCase()) return device.udid;
      }
    }
  } catch {}
  console.error(`Could not resolve device: ${nameOrUDID}`);
  process.exit(1);
}

export type SimulatorDeviceInfo = {
  udid: string;
  name: string;
  deviceTypeIdentifier?: string;
};

let simulatorDeviceInfoCache: Map<string, SimulatorDeviceInfo> | undefined;
let simulatorDeviceInfoInflight: Promise<Map<string, SimulatorDeviceInfo> | undefined> | undefined;

function parseSimulatorDeviceInfo(output: string): Map<string, SimulatorDeviceInfo> {
  const data = JSON.parse(output) as {
    devices: Record<string, Array<{ udid: string; name: string; deviceTypeIdentifier?: string }>>;
  };
  const cache = new Map<string, SimulatorDeviceInfo>();
  for (const devices of Object.values(data.devices)) {
    for (const device of devices) {
      cache.set(device.udid.toUpperCase(), {
        udid: device.udid,
        name: device.name,
        deviceTypeIdentifier: device.deviceTypeIdentifier,
      });
    }
  }
  return cache;
}

async function refreshSimulatorDeviceInfo(): Promise<Map<string, SimulatorDeviceInfo> | undefined> {
  if (simulatorDeviceInfoInflight) return simulatorDeviceInfoInflight;
  simulatorDeviceInfoInflight = (async () => {
    try {
      const { stdout } = await execFileAsync("xcrun", simctlArguments(["list", "devices", "-j"]), { encoding: "utf-8" });
      simulatorDeviceInfoCache = parseSimulatorDeviceInfo(stdout);
      return simulatorDeviceInfoCache;
    } catch {
      simulatorDeviceInfoCache = undefined;
      return undefined;
    } finally {
      simulatorDeviceInfoInflight = undefined;
    }
  })();
  return simulatorDeviceInfoInflight;
}

/** Name and device type for `udid` from `simctl list`. Refreshes on a miss so a
 *  device created after the first lookup can still resolve. */
export async function simulatorDeviceInfo(udid: string): Promise<SimulatorDeviceInfo | null> {
  const key = udid.toUpperCase();
  const hit = simulatorDeviceInfoCache?.get(key);
  if (hit) return hit;
  const cache = await refreshSimulatorDeviceInfo();
  return cache?.get(key) ?? null;
}
