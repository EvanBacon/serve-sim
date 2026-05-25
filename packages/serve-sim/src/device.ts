import { execSync } from "child_process";

export interface FindBootedOptions {
  /**
   * When true, prefer a booted tvOS simulator and exclude full-resolution 4K
   * models so the streaming frame rate stays high. The "(at 1080p)" 4K
   * variants are kept because they output a 1080p framebuffer.
   */
  tv?: boolean;
}

/**
 * True for Apple TV simulators whose framebuffer is 1080p — i.e. plain
 * "Apple TV" / older numbered "Apple TV 15", and the "(at 1080p)" 4K variants.
 * Filters out the full-resolution 4K (3840×2160) sims, which choke the encoder.
 */
export function isTvLowResolution(name: string): boolean {
  if (!/apple\s*tv/i.test(name)) return false;
  if (!/4K/i.test(name)) return true;
  return /1080p?\b/i.test(name);
}

/**
 * UDID of a booted simulator, or null if none is booted. By default prefers an
 * iOS device; pass `{ tv: true }` to prefer a 1080p tvOS device instead.
 */
export function findBootedDevice(opts: FindBootedOptions = {}): string | null {
  try {
    const output = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
    };
    let fallback: string | null = null;
    for (const [runtime, devices] of Object.entries(data.devices)) {
      for (const device of devices) {
        if (device.state !== "Booted") continue;
        if (opts.tv) {
          if (!/tvOS/i.test(runtime)) continue;
          if (!isTvLowResolution(device.name)) continue;
          return device.udid;
        }
        if (/iOS/i.test(runtime)) return device.udid;
        if (/tvOS/i.test(runtime)) continue;
        fallback ??= device.udid;
      }
    }
    return fallback;
  } catch {}
  return null;
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
  console.error(`Could not resolve device: ${nameOrUDID}`);
  process.exit(1);
}
