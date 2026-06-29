import { execSync } from "child_process";
import { listDevicesNative } from "./native";

/** A device entry in the shape `simctl list devices -j` reports per device. */
export interface SimctlDevice {
  udid: string;
  name: string;
  /** "Creating" | "Shutdown" | "Booting" | "Booted" | "Shutting Down". */
  state: string;
  isAvailable?: boolean;
  /** e.g. "com.apple.CoreSimulator.SimDeviceType.iPhone-17". */
  deviceTypeIdentifier?: string;
}

/** Devices keyed by runtime identifier — `simctl list devices -j`'s `.devices`. */
export type SimctlDevicesByRuntime = Record<string, SimctlDevice[]>;

/**
 * Devices grouped by runtime identifier, matching `simctl list devices -j`'s
 * `.devices` map — but sourced from the in-process reactive CoreSimulator
 * subscriber (`native.listDevicesNative`), which keeps a live snapshot via XPC
 * push notifications from `com.apple.CoreSimulator.CoreSimulatorService` instead
 * of spawning `simctl` per call.
 *
 * Falls back to a one-shot `xcrun simctl list devices -j` when the native addon
 * isn't available (e.g. the prebuilt `.node` is missing), so callers keep
 * working with identical output.
 */
export function listDevicesByRuntime(): SimctlDevicesByRuntime {
  return tryListDevicesByRuntime() ?? {};
}

/**
 * Like {@link listDevicesByRuntime} but returns `null` when the device set could
 * not be read at all (native subscription unavailable *and* `simctl` failed).
 * `listBootedUdids` (and other destructive callers) rely on the `null` so a
 * transient lookup failure isn't mistaken for an empty device set.
 */
function tryListDevicesByRuntime(): SimctlDevicesByRuntime | null {
  // Reactive in-process subscriber first.
  try {
    const grouped: SimctlDevicesByRuntime = {};
    for (const d of listDevicesNative()) {
      (grouped[d.runtimeIdentifier] ??= []).push({
        udid: d.udid,
        name: d.name,
        state: d.state,
        isAvailable: d.isAvailable,
        deviceTypeIdentifier: d.deviceTypeIdentifier || undefined,
      });
    }
    return grouped;
  } catch {
    // Native addon missing or subscription failed — fall through to simctl.
  }
  // One-shot `xcrun simctl list devices -j` fallback.
  try {
    const output = execSync("xcrun simctl list devices -j", { encoding: "utf-8" });
    return (JSON.parse(output) as { devices: SimctlDevicesByRuntime }).devices ?? {};
  } catch {
    return null;
  }
}

/** Iterate `[runtimeIdentifier, device]` over the current device set. */
export function* eachDevice(): Generator<[string, SimctlDevice]> {
  for (const [runtime, devices] of Object.entries(listDevicesByRuntime())) {
    for (const device of devices) yield [runtime, device];
  }
}

/**
 * Set of booted device UDIDs, or null when the device set couldn't be read at
 * all — so destructive callers (e.g. pruning a "stale" helper) don't mistake a
 * lookup failure for "nothing booted". Backed by the reactive snapshot.
 */
export function listBootedUdids(): Set<string> | null {
  const grouped = tryListDevicesByRuntime();
  if (grouped === null) return null;
  const booted = new Set<string>();
  for (const devices of Object.values(grouped)) {
    for (const device of devices) {
      if (device.state === "Booted") booted.add(device.udid);
    }
  }
  return booted;
}

/**
 * UDID of a booted simulator, or null if none is booted. Prefers an iOS device
 * — a machine may also have a booted watchOS/tvOS sim, which `serve-sim`'s
 * tooling doesn't target.
 */
export function findBootedDevice(): string | null {
  let fallback: string | null = null;
  for (const [runtime, device] of eachDevice()) {
    if (device.state !== "Booted") continue;
    if (/iOS/i.test(runtime)) return device.udid;
    fallback ??= device.udid;
  }
  return fallback;
}

/**
 * Resolve a device name or UDID to a UDID. A UDID is returned as-is; a name is
 * matched case-insensitively against the device set. Exits the process with a
 * clear error when the name cannot be resolved.
 */
export function resolveDevice(nameOrUDID: string): string {
  if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(nameOrUDID)) {
    return nameOrUDID;
  }
  for (const [, device] of eachDevice()) {
    if (device.name.toLowerCase() === nameOrUDID.toLowerCase()) return device.udid;
  }
  console.error(`Could not resolve device: ${nameOrUDID}`);
  process.exit(1);
}
