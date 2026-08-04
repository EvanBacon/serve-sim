/**
 * Arguments for monitoring a boot that serve-sim has already requested.
 *
 * `-b` means "boot if needed". Keeping it out is intentional: after a separate
 * `simctl boot`, Xcode 27 can leave the redundant boot-and-monitor form blocked
 * even though the device is already Booted. This form only monitors the boot
 * transition that serve-sim requested.
 */
export function simctlBootStatusArguments(udid: string): [string, string, string] {
  return ["simctl", "bootstatus", udid];
}
