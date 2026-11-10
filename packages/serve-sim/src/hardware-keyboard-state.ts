import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { simulatorDevicesDir } from "./simctl";
import { STATE_DIR } from "./state";

/**
 * The guest has no getter for "Connect Hardware Keyboard", and an explicit
 * set persists for the rest of the simulator boot (across serve-sim
 * restarts). Remember the last explicit value, keyed by boot. Values from an
 * earlier boot are ignored: initial visibility after boot isn't predictable
 * from them.
 */
export interface HardwareKeyboardStateOptions {
  stateDir?: string;
  devicesDir?: string;
}

/** CoreSimulator rewrites this plist on every boot, so its mtime identifies the boot. */
function bootKey(udid: string, devicesDir: string): number | null {
  try {
    return statSync(join(devicesDir, udid, "data/var/run/launchd_bootstrap.plist")).mtimeMs;
  } catch {
    return null;
  }
}

function paths(udid: string, opts: HardwareKeyboardStateOptions) {
  const stateDir = opts.stateDir ?? STATE_DIR;
  return {
    stateDir,
    file: join(stateDir, `hardware-keyboard-${udid}.json`),
    devicesDir: opts.devicesDir ?? simulatorDevicesDir(),
  };
}

/** The explicit value set during this boot, or null (none, earlier boot, or corrupt state). */
export function readHardwareKeyboardState(udid: string, opts: HardwareKeyboardStateOptions = {}): boolean | null {
  const { file, devicesDir } = paths(udid, opts);
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown; bootKey?: unknown } | null;
    if (typeof saved?.enabled !== "boolean") return null;
    const key = bootKey(udid, devicesDir);
    return key != null && saved.bootKey === key ? saved.enabled : null;
  } catch {
    return null;
  }
}

/** Best effort; never throws. Skipped when the boot can't be identified. */
export function writeHardwareKeyboardState(udid: string, enabled: boolean, opts: HardwareKeyboardStateOptions = {}): void {
  try {
    const { stateDir, file, devicesDir } = paths(udid, opts);
    const key = bootKey(udid, devicesDir);
    if (key == null) return;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ enabled, bootKey: key }));
  } catch {}
}

// Software keyboard keys carry these AXUniqueIds; the hardware keyboard
// state (no software keyboard on screen) has none of them.
const SOFTWARE_KEYBOARD_KEY_IDS = new Set(["space", "shift"]);

/**
 * True when a raw `axDescribeAsync` tree (an array of nodes with
 * `AXUniqueId` and nested `children`) contains a software keyboard key.
 */
export function axTreeHasSoftwareKeyboard(tree: unknown): boolean {
  if (Array.isArray(tree)) return tree.some(axTreeHasSoftwareKeyboard);
  if (!tree || typeof tree !== "object") return false;
  const node = tree as { AXUniqueId?: unknown; children?: unknown };
  return (typeof node.AXUniqueId === "string" && SOFTWARE_KEYBOARD_KEY_IDS.has(node.AXUniqueId))
    || axTreeHasSoftwareKeyboard(node.children);
}
