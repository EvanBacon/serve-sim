import { tmpdir } from "os";
import { join } from "path";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";

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
  /**
   * sha256 (hex) of the `--auth-token` the server was started with, so a
   * later `--detach` / follow never silently reuses a server guarded by a
   * different token (or by none). Absent when the server has no auth token.
   */
  authTokenSha256?: string;
  /**
   * Whether the server was started with `--allow-exec`, so a later
   * `--detach` / follow never silently reuses a server whose host-shell
   * opt-in differs from the one requested. Absent means off.
   */
  allowExec?: boolean;
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

/** Owner-only (0700) directory holding exec tokens for `serve-sim exec`. */
export const EXEC_TOKEN_DIR = join(STATE_DIR, "exec-tokens");

/** Exec token file for the preview server listening on `port`. */
export function execTokenFileForPort(port: number): string {
  return join(EXEC_TOKEN_DIR, `${port}.token`);
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error(`Refusing to use ${dir}: not a directory owned by the current user`);
  }
  chmodSync(dir, 0o700);
}

/**
 * Hand the `/exec` token to the local CLI. The token is never served over
 * HTTP — a client that only reaches the preview port (including through a raw
 * TCP forward) cannot read it; only a process running as this user can.
 */
export function writeExecTokenFile(port: number, token: string): string {
  ensurePrivateDir(EXEC_TOKEN_DIR);
  const file = execTokenFileForPort(port);
  const tmp = `${file}.${process.pid}.tmp`;
  try { unlinkSync(tmp); } catch {}
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  return file;
}

export function readExecTokenFile(port: number): string | null {
  try {
    const token = readFileSync(execTokenFileForPort(port), "utf-8").trim();
    return token === "" ? null : token;
  } catch {
    return null;
  }
}

export function removeExecTokenFile(port: number): void {
  try { unlinkSync(execTokenFileForPort(port)); } catch {}
}
