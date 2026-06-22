import { tmpdir } from "os";
import { join } from "path";
import { readdirSync, mkdirSync, writeFileSync, renameSync } from "fs";

/** Directory where serve-sim stores runtime state. */
export const STATE_DIR = join(tmpdir(), "serve-sim");

/** Path to the serve-sim server state file (JSON with pid, port, URLs).
 *  @deprecated Use `stateFileForDevice(udid)` for multi-device support. Kept for backward compat. */
export const STATE_FILE = join(STATE_DIR, "server.json");

/** Per-device state file: `/tmp/serve-sim/server-{udid}.json` */
export function stateFileForDevice(udid: string): string {
  return join(STATE_DIR, `server-${udid}.json`);
}

/** Runtime record for a device streamed in-process by a preview server. */
export interface ServeSimDeviceState {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
}

/**
 * Build the state for a device served in-process. There's no separate helper
 * port — the URLs point at the preview server's own same-origin
 * `{base}/helper/<device>/…` routes, which simMiddleware serves from a
 * NativeCapture/NativeHid DeviceSession.
 */
export function inProcessServeSimState(
  udid: string,
  port: number,
  base = "/",
  host = "127.0.0.1",
): ServeSimDeviceState {
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  // Normalize to a leading-slash, no-trailing-slash prefix so a base without a
  // leading slash (e.g. "foo") still yields well-formed `…:port/foo/helper/…`.
  const trimmed = base.replace(/^\/+/, "").replace(/\/+$/, "");
  const prefix = trimmed === "" ? "" : `/${trimmed}`;
  return {
    pid: process.pid,
    port,
    device: udid,
    url: `http://${h}:${port}`,
    streamUrl: `http://${h}:${port}${prefix}/helper/${udid}/stream.mjpeg`,
    wsUrl: `ws://${h}:${port}${prefix}/helper/${udid}/ws`,
  };
}

/** Persist a device's state so other processes / the grid can enumerate it.
 *  Writes atomically (temp file + rename) so a concurrent reader never observes
 *  a truncated or partially-written file. */
export function writeServeSimState(state: ServeSimDeviceState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const file = stateFileForDevice(state.device);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
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
