import { execFileSync, spawn } from "child_process";
import { existsSync, openSync, closeSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type AndroidTargetState = "Booted" | "Shutdown" | "Offline" | "Unauthorized" | "Unknown";

export interface AndroidTarget {
  platform: "android";
  device: string;
  name: string;
  runtime: string;
  state: AndroidTargetState;
  serial?: string;
  avdName?: string;
  isEmulator: boolean;
}

export interface ParsedAdbDevice {
  serial: string;
  state: string;
  attrs: Record<string, string>;
}

const DEFAULT_ADB_TIMEOUT_MS = 3_000;
const ANDROID_BOOT_TIMEOUT_MS = 120_000;

function sdkRoots(): string[] {
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
  ].filter((value): value is string => !!value);
}

function commandWorks(command: string, args: string[] = ["--version"]): boolean {
  try {
    execFileSync(command, args, {
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 1500,
    });
    return true;
  } catch {
    return false;
  }
}

export function findAdb(): string | null {
  for (const root of sdkRoots()) {
    const candidate = join(root, "platform-tools", "adb");
    if (existsSync(candidate)) return candidate;
  }
  return commandWorks("adb", ["version"]) ? "adb" : null;
}

export function findEmulator(): string | null {
  for (const root of sdkRoots()) {
    const candidate = join(root, "emulator", "emulator");
    if (existsSync(candidate)) return candidate;
  }
  return commandWorks("emulator", ["-version"]) ? "emulator" : null;
}

export function adb(args: string[], opts?: { timeout?: number; encoding?: BufferEncoding }): string {
  const command = findAdb();
  if (!command) {
    throw new Error("adb not found. Install Android Studio or set ANDROID_HOME/ANDROID_SDK_ROOT.");
  }
  return execFileSync(command, args, {
    encoding: opts?.encoding ?? "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts?.timeout ?? DEFAULT_ADB_TIMEOUT_MS,
  }).toString();
}

export function parseAdbDevices(stdout: string): ParsedAdbDevice[] {
  const devices: ParsedAdbDevice[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("List of devices")) continue;
    const [serial, state, ...rest] = line.split(/\s+/);
    if (!serial || !state) continue;
    const attrs: Record<string, string> = {};
    for (const part of rest) {
      const idx = part.indexOf(":");
      if (idx <= 0) continue;
      attrs[part.slice(0, idx)] = part.slice(idx + 1);
    }
    devices.push({ serial, state, attrs });
  }
  return devices;
}

function androidState(adbState: string): AndroidTargetState {
  switch (adbState) {
    case "device":
      return "Booted";
    case "offline":
      return "Offline";
    case "unauthorized":
      return "Unauthorized";
    default:
      return "Unknown";
  }
}

function friendlyModel(value: string | undefined, fallback: string): string {
  return (value || fallback).replace(/_/g, " ");
}

function getAndroidProp(serial: string, prop: string, timeout = 1500): string {
  try {
    return adb(["-s", serial, "shell", "getprop", prop], { timeout }).trim();
  } catch {
    return "";
  }
}

function describeRunningDevice(device: ParsedAdbDevice): AndroidTarget {
  const isEmulator = device.serial.startsWith("emulator-");
  const release = getAndroidProp(device.serial, "ro.build.version.release");
  const api = getAndroidProp(device.serial, "ro.build.version.sdk");
  const avdName = isEmulator
    ? getAndroidProp(device.serial, "ro.kernel.qemu.avd_name") || undefined
    : undefined;
  const name = avdName
    ? avdName.replace(/_/g, " ")
    : friendlyModel(device.attrs.model, device.serial);
  const runtime = release
    ? `Android ${release}${api ? ` (API ${api})` : ""}`
    : "Android";
  return {
    platform: "android",
    device: device.serial,
    serial: device.serial,
    avdName,
    name,
    runtime,
    state: androidState(device.state),
    isEmulator,
  };
}

export function listRunningAndroidDevices(): AndroidTarget[] {
  try {
    return parseAdbDevices(adb(["devices", "-l"]))
      .map(describeRunningDevice)
      .filter((device) => device.state !== "Unknown");
  } catch {
    return [];
  }
}

export function listAndroidAvds(): AndroidTarget[] {
  const emulator = findEmulator();
  if (!emulator) return [];
  try {
    const out = execFileSync(emulator, ["-list-avds"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((avdName) => ({
        platform: "android" as const,
        device: avdName,
        avdName,
        name: avdName.replace(/_/g, " "),
        runtime: "Android Emulator",
        state: "Shutdown" as const,
        isEmulator: true,
      }));
  } catch {
    return [];
  }
}

export function listAndroidTargets(): AndroidTarget[] {
  const running = listRunningAndroidDevices();
  const runningAvds = new Set(
    running
      .map((device) => device.avdName)
      .filter((value): value is string => !!value),
  );
  const stoppedAvds = listAndroidAvds().filter(
    (device) => !device.avdName || !runningAvds.has(device.avdName),
  );
  return [...running, ...stoppedAvds];
}

export function findBootedAndroidDevice(): string | null {
  return listRunningAndroidDevices().find((device) => device.state === "Booted")?.device ?? null;
}

export function isAndroidDeviceBooted(serial: string): boolean {
  try {
    return adb(["-s", serial, "get-state"], { timeout: 1500 }).trim() === "device";
  } catch {
    return false;
  }
}

export function resolveRunningAndroidDevice(nameOrSerial: string): AndroidTarget | null {
  const wanted = nameOrSerial.toLowerCase();
  for (const device of listRunningAndroidDevices()) {
    if (device.device.toLowerCase() === wanted) return device;
    if (device.serial?.toLowerCase() === wanted) return device;
    if (device.avdName?.toLowerCase() === wanted) return device;
    if (device.name.toLowerCase() === wanted) return device;
  }
  return null;
}

export function resolveAndroidTarget(nameOrSerial: string): AndroidTarget | null {
  const running = resolveRunningAndroidDevice(nameOrSerial);
  if (running) return running;
  const wanted = nameOrSerial.toLowerCase();
  return listAndroidAvds().find(
    (device) =>
      device.device.toLowerCase() === wanted ||
      device.avdName?.toLowerCase() === wanted ||
      device.name.toLowerCase() === wanted,
  ) ?? null;
}

export function pickDefaultAndroidTarget(): AndroidTarget | null {
  return listRunningAndroidDevices().find((device) => device.state === "Booted")
    ?? listAndroidAvds()[0]
    ?? null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBootedAndroidDevice(
  match: (device: AndroidTarget) => boolean,
  timeoutMs = ANDROID_BOOT_TIMEOUT_MS,
): Promise<AndroidTarget> {
  const deadline = Date.now() + timeoutMs;
  let lastDevice: AndroidTarget | null = null;
  while (Date.now() < deadline) {
    const devices = listRunningAndroidDevices();
    lastDevice = devices.find(match) ?? null;
    if (lastDevice?.serial && lastDevice.state === "Booted") {
      const completed = getAndroidProp(lastDevice.serial, "sys.boot_completed", 2500);
      if (completed === "1") return lastDevice;
    }
    await sleep(1000);
  }
  throw new Error(
    lastDevice
      ? `Android device ${lastDevice.device} did not finish booting in time`
      : "Android emulator did not appear in adb devices in time",
  );
}

export async function ensureAndroidBooted(target: AndroidTarget, logFile?: string): Promise<AndroidTarget> {
  if (target.serial && target.state === "Booted" && isAndroidDeviceBooted(target.serial)) {
    return target;
  }

  if (!target.avdName) {
    throw new Error(`Android device ${target.device} is not booted`);
  }

  const emulator = findEmulator();
  if (!emulator) {
    throw new Error("Android emulator not found. Install Android Studio or set ANDROID_HOME/ANDROID_SDK_ROOT.");
  }

  const before = new Set(listRunningAndroidDevices().map((device) => device.device));
  let outFd: number | undefined;
  try {
    if (logFile) outFd = openSync(logFile, "a");
    const child = spawn(emulator, ["-avd", target.avdName], {
      detached: true,
      stdio: ["ignore", outFd ?? "ignore", outFd ?? "ignore"],
    });
    child.unref();
  } finally {
    if (outFd !== undefined) closeSync(outFd);
  }

  return waitForBootedAndroidDevice((device) => {
    if (device.avdName === target.avdName) return true;
    return device.isEmulator && !before.has(device.device);
  });
}

export function shutdownAndroidDevice(serial: string): void {
  if (serial.startsWith("emulator-")) {
    try {
      adb(["-s", serial, "emu", "kill"], { timeout: 5_000 });
      return;
    } catch {}
  }
  adb(["-s", serial, "shell", "reboot", "-p"], { timeout: 5_000 });
}

export function parseWmSize(stdout: string): { width: number; height: number } | null {
  const match = /(?:Physical|Override) size:\s*(\d+)x(\d+)/i.exec(stdout);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

export function androidInputTextArg(text: string): string {
  return text
    .replace(/%/g, "%25")
    .replace(/\s/g, "%s")
    .replace(/[\\'"`$&|;<>*?()[\]{}]/g, "\\$&");
}
