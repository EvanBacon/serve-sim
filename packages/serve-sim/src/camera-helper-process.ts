import { spawn as nodeSpawn } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
  CAMERA_STATE_DIR,
  cameraHelperBundlesFile,
  cameraHelperPidFile,
} from "./camera-helper";
import { isProcessAlive } from "./helper-lifecycle";
import { sleepSync } from "./runtime";

// Host-side lifecycle of the `serve-sim-camera-helper` process behind
// `serve-sim camera`: spawn it detached with its output in a per-UDID log,
// record its pid, wait for its control socket, and reap it again. Kept out of
// index.ts so the spawn contract can be exercised with a stand-in binary.

export type CamSourceKind = "placeholder" | "webcam" | "image" | "video";

export function clearInjectedBundles(udid: string): void {
  try { unlinkSync(cameraHelperBundlesFile(udid)); } catch {}
}

export function stopExistingHelper(udid: string) {
  const pf = cameraHelperPidFile(udid);
  if (!existsSync(pf)) return;
  const pid = Number(readFileSync(pf, "utf-8").trim());
  if (Number.isFinite(pid) && isProcessAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    // Give it a moment to clean up the shm region.
    const start = Date.now();
    while (isProcessAlive(pid) && Date.now() - start < 1500) sleepSync(50);
  }
  try { unlinkSync(pf); } catch {}
  clearInjectedBundles(udid);
}

export function spawnCameraHelper(args: {
  udid: string;
  helperBin: string;
  shmName: string;
  socketPath: string;
  source: CamSourceKind;
  arg?: string;
  width?: number;
  height?: number;
}): number {
  if (!existsSync(CAMERA_STATE_DIR)) mkdirSync(CAMERA_STATE_DIR, { recursive: true });
  const logPath = join(CAMERA_STATE_DIR, `${args.udid}.log`);
  const out = openSync(logPath, "a");
  const argv = [
    "--shm", args.shmName,
    "--socket", args.socketPath,
    "--source", args.source,
  ];
  if (args.arg) argv.push("--arg", args.arg);
  if (args.width) argv.push("--width", String(args.width));
  if (args.height) argv.push("--height", String(args.height));
  const child = nodeSpawn(args.helperBin, argv, {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  closeSync(out);
  if (!child.pid) throw new Error("failed to spawn camera helper");
  writeFileSync(cameraHelperPidFile(args.udid), String(child.pid));
  clearInjectedBundles(args.udid);
  // Wait briefly until the helper has populated the shm header AND the
  // control socket is listening (proves it's healthy and ready for switch).
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (!isProcessAlive(child.pid)) {
      throw new Error(`camera helper exited early — see log at ${logPath}`);
    }
    if (existsSync(args.socketPath)) break;
    sleepSync(50);
  }
  return child.pid;
}
