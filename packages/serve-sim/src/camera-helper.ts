import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "./state";

export const CAMERA_STATE_DIR = join(STATE_DIR, "simcam");
const HELPER_TIMEOUT_MS = 3000;

interface InjectedBundlesState {
  helperPid: number;
  bundleIds: string[];
}

export interface CameraHelperReply {
  [key: string]: unknown;
  ok?: boolean;
  source?: string;
  arg?: string;
  mirror?: string;
  error?: string;
}

export interface CameraStatusReply extends CameraHelperReply {
  udid: string;
  alive: boolean;
  helperPid?: number | null;
  bundleIds?: string[];
}

export function cameraHelperPidFile(udid: string): string {
  return join(CAMERA_STATE_DIR, `${udid}.pid`);
}

export function cameraHelperBundlesFile(udid: string): string {
  return join(CAMERA_STATE_DIR, `${udid}.bundles.json`);
}

export function cameraHelperSocketFile(udid: string): string {
  // POSIX sun_path is 104 chars on macOS, so keep this short.
  const short = createHash("sha1").update(udid).digest("hex").slice(0, 12);
  return `/tmp/serve-sim-cam-${short}.sock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readCameraHelperPid(udid: string): number | null {
  try {
    const pid = Number(readFileSync(cameraHelperPidFile(udid), "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function parseCameraHelperReply(value: unknown): CameraHelperReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid camera helper reply");
  }
  return value as CameraHelperReply;
}

export async function sendCameraHelperCommand(
  udid: string,
  command: object,
): Promise<CameraHelperReply> {
  const socketPath = cameraHelperSocketFile(udid);
  if (!existsSync(socketPath)) throw new Error("camera helper socket not found");
  const net = await import("net");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const settle = (error?: unknown, reply?: CameraHelperReply) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(reply ?? {});
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        settle(undefined, parseCameraHelperReply(JSON.parse(buffer.slice(0, newline)) as unknown));
      } catch (error) {
        settle(error);
      }
      socket.end();
    });
    socket.on("error", settle);
    socket.on("close", () => settle(new Error("socket closed")));
    timeout = setTimeout(() => {
      socket.destroy();
      settle(new Error("helper timeout"));
    }, HELPER_TIMEOUT_MS);
    socket.write(JSON.stringify(command) + "\n");
  });
}

export function isCameraHelperAlive(udid: string): boolean {
  const pid = readCameraHelperPid(udid);
  return pid !== null && isProcessAlive(pid) && existsSync(cameraHelperSocketFile(udid));
}

export function readInjectedCameraBundles(udid: string): string[] {
  let state: InjectedBundlesState;
  try {
    const value = JSON.parse(readFileSync(cameraHelperBundlesFile(udid), "utf-8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = value as Partial<InjectedBundlesState>;
    if (typeof candidate.helperPid !== "number" || !Array.isArray(candidate.bundleIds)) return [];
    state = { helperPid: candidate.helperPid, bundleIds: candidate.bundleIds };
  } catch {
    return [];
  }
  const currentHelperPid = readCameraHelperPid(udid);
  if (currentHelperPid === null || state.helperPid !== currentHelperPid) return [];
  return state.bundleIds.filter((bundleId): bundleId is string => typeof bundleId === "string");
}

export async function readCameraStatus(udid: string): Promise<CameraStatusReply> {
  if (!isCameraHelperAlive(udid)) return { udid, alive: false };

  const helperPid = readCameraHelperPid(udid);
  const bundleIds = readInjectedCameraBundles(udid);
  try {
    const reply = await sendCameraHelperCommand(udid, { action: "status" });
    return { ...reply, udid, alive: true, helperPid, bundleIds };
  } catch (error) {
    return {
      udid,
      alive: true,
      helperPid,
      bundleIds,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
