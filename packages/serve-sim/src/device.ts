import { execSync } from "child_process";

export function isIosUdid(value: string): boolean {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(value);
}

/**
 * UDID of a booted simulator, or null if none is booted. Prefers an iOS device
 * — a machine may also have a booted watchOS/tvOS sim, which `serve-sim`'s
 * tooling doesn't target.
 */
export function findBootedDevice(): string | null {
  try {
    const output = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
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

/**
 * Resolve a device name or UDID to a UDID. A UDID is returned as-is; a name is
 * matched case-insensitively against `simctl list devices`.
 */
export function tryResolveDevice(nameOrUDID: string): string | null {
  if (isIosUdid(nameOrUDID)) {
    return nameOrUDID;
  }
  try {
    const output = execSync("xcrun simctl list devices -j", { encoding: "utf-8" });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
    };
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.name.toLowerCase() === nameOrUDID.toLowerCase()) return device.udid;
      }
    }
  } catch {}
  return null;
}

/**
 * Resolve a device name or UDID to a UDID. Exits the process with a clear
 * error when the name cannot be resolved.
 */
export function resolveDevice(nameOrUDID: string): string {
  const resolved = tryResolveDevice(nameOrUDID);
  if (resolved) return resolved;
  console.error(`Could not resolve device: ${nameOrUDID}`);
  process.exit(1);
}
