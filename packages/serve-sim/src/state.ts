import { tmpdir } from "os";
import { join } from "path";
import { readdirSync } from "fs";

/** Directory where serve-sim stores runtime state. */
export const STATE_DIR = join(tmpdir(), "serve-sim");

/** Path to the serve-sim server state file (JSON with pid, port, URLs).
 *  @deprecated Use `stateFileForDevice(udid)` for multi-device support. Kept for backward compat. */
export const STATE_FILE = join(STATE_DIR, "server.json");

/** Per-device state file: `/tmp/serve-sim/server-{udid}.json` */
export function stateFileForDevice(udid: string): string {
  return join(STATE_DIR, `server-${udid}.json`);
}

/** List all per-device state files in the state directory. */
export function listStateFiles(): string[] {
  try {
    return readdirSync(STATE_DIR)
      .filter((f) => f.startsWith("server-") && f.endsWith(".json"))
      .map((f) => join(STATE_DIR, f));
  } catch {
    return [];
  }
}
