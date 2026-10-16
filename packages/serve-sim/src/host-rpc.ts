import { execFile } from "child_process";
import { randomUUID } from "crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { PERMISSION_SERVICES } from "./client/utils/permissions";
import { shellJoin } from "./shell-quote";
import { getUiOption, setUiOption } from "./ui-settings";

// Narrow host actions for the preview page, carried as `{id, rpc}` frames on
// the `/exec-ws` control channel. The page never sends shell text: every
// method validates its params against strict formats/enums, checks that the
// udid is a booted simulator, and spawns a fixed argv with no shell. These
// stay available without `--allow-exec` (which gates arbitrary commands),
// except `installApp`: installing and launching an arbitrary .ipa runs
// attacker-chosen code on the host, so it (and staging an install upload)
// needs `--allow-exec` too. The channel itself still applies the
// loopback/same-origin and auth gates before a frame reaches here.

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type HostRpcRunner = (file: string, args: string[]) => Promise<RunResult>;

export interface HostRpcOptions {
  /** CLI entry used for `serve-sim permissions|camera …` (see serveSimArgv). */
  serveSimBin: string;
  /** Whether `udid` is a simulator this server may act on (e.g. booted). */
  isKnownDevice: (udid: string) => Promise<boolean>;
  /** Process runner; tests substitute a recorder. Never invokes a shell. */
  run?: HostRpcRunner;
  /** Observer for completed commands (event log), shell-quoted for display. */
  onCommandResult?: (command: string, result: RunResult) => void;
  /** Home directory for screenshot paths. Default: `os.homedir()`. */
  homeDir?: string;
  /**
   * Whether the server opted in to host code execution (`--allow-exec`).
   * Required for `installApp` and for staging `serve-sim-install-*` uploads.
   */
  allowExec?: boolean;
}

export type HostRpcHandler = (payload: unknown) => Promise<Record<string, unknown>>;

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Matches the client's DROP_MAX_FILE_SIZE. */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Generous cap per chunk; the client sends 192KB slices. */
const MAX_CHUNK_BYTES = 1024 * 1024;

const UDID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
// Reverse-DNS bundle ids. Must start alphanumeric so it can't read as a flag.
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Files the page staged through uploadChunk: `/tmp/<prefix>-<uuid>.<ext>`.
const UPLOAD_PATH_RE = new RegExp(`^/tmp/serve-sim-(upload|install|camsrc)-${UUID}\\.([a-z0-9]{1,10})$`);
const SCREENSHOT_NAME_RE = /^serve-sim-screenshot-[0-9A-Za-z-]{1,64}\.png$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const PERMISSION_ACTIONS = ["grant", "revoke", "reset"] as const;
const PERMISSION_NAMES = new Set(PERMISSION_SERVICES.map((s) => s.key));
const CAMERA_SOURCES = ["placeholder", "webcam", "image", "video"] as const;
const MIRROR_VALUES = ["on", "off"] as const;
const DISPLAYS = ["primary", "primary-1"] as const;

export const INSTALL_REQUIRES_EXEC = "installApp requires --allow-exec";

const WATCH_HOME_SCRIPT = [
  'tell application "System Events" to tell process "Simulator" to set frontmost to true',
  'tell application "System Events" to tell process "Simulator" to perform action "AXRaise" of (first window whose name contains "watchOS")',
  'tell application "System Events" to tell process "Simulator" to click menu item "Home" of menu "Device" of menu bar item "Device" of menu bar 1',
];

type Params = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

function udidParam(p: Params): string {
  const v = p.udid;
  if (typeof v !== "string" || !UDID_RE.test(v)) fail("invalid udid");
  return v;
}

function bundleIdParam(p: Params): string {
  const v = p.bundleId;
  if (typeof v !== "string" || !BUNDLE_ID_RE.test(v)) fail("invalid bundle id");
  return v;
}

function enumParam<T extends string>(p: Params, key: string, values: readonly T[]): T {
  const v = p[key];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) fail(`invalid ${key}`);
  return v as T;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Host webcam id or name (spaces allowed): no controls, never a flag. */
function webcamIdParam(p: Params): string | undefined {
  const v = p.webcamId;
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string" || v.length > 256 || v.startsWith("-") || hasControlChar(v)) {
    fail("invalid webcamId");
  }
  return v;
}

function uploadPathParam(p: Params, key = "path", prefixes?: readonly string[]): string {
  const v = p[key];
  const m = typeof v === "string" ? UPLOAD_PATH_RE.exec(v) : null;
  if (!m || (prefixes && !prefixes.includes(m[1]!))) fail(`invalid ${key}`);
  return v as string;
}

function coordinate(p: Params, key: "lat" | "lng", limit: number): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > limit) fail(`invalid ${key}`);
  return v;
}

/** `node|bun <bin>` for script entries, the binary itself otherwise. */
export function serveSimArgv(bin: string, args: string[]): [string, string[]] {
  if (/\.ts$/.test(bin)) return ["bun", [bin, ...args]];
  if (/\.js$/.test(bin)) return ["node", [bin, ...args]];
  return [bin, args];
}

function defaultRun(file: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf-8" }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") || (err && typeof code !== "number" ? err.message : ""),
        exitCode: err ? (typeof code === "number" ? code : 127) : 0,
      });
    });
  });
}

function timestampSlug(): string {
  // 2026-06-11T14-12-44-123 — filesystem-safe, sorts chronologically. Keep the
  // milliseconds so two captures in the same second don't clobber one file.
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
}

export function createHostRpcHandler(opts: HostRpcOptions): HostRpcHandler {
  const runner = opts.run ?? defaultRun;
  const desktop = () => join(opts.homeDir ?? homedir(), "Desktop");

  const run = async (file: string, args: string[]): Promise<RunResult> => {
    const result = await runner(file, args);
    try {
      opts.onCommandResult?.(shellJoin([file, ...args]), result);
    } catch {
      // Diagnostic side-channel only.
    }
    return result;
  };
  const serveSim = (args: string[]) => run(...serveSimArgv(opts.serveSimBin, args));

  const requireDevice = async (udid: string) => {
    if (!(await opts.isKnownDevice(udid))) fail(`unknown or not booted device: ${udid}`);
  };

  /** A screenshot this server wrote: `~/Desktop/serve-sim-screenshot-*.png`. */
  const screenshotPathParam = (p: Params): string => {
    const v = p.path;
    if (typeof v !== "string" || dirname(v) !== desktop() || !SCREENSHOT_NAME_RE.test(basename(v))) {
      fail("invalid path");
    }
    return v;
  };

  const appContainer = async (udid: string, bundleId: string): Promise<string> => {
    const r = await run("xcrun", ["simctl", "get_app_container", udid, bundleId, "app"]);
    if (r.exitCode !== 0) fail(r.stderr.trim() || "App not found on simulator");
    const appPath = r.stdout.trim();
    if (!appPath) fail("Empty app path");
    return appPath;
  };

  const cameraFileArg = (p: Params): string => uploadPathParam(p, "filePath", ["camsrc"]);

  const methods: Record<string, (p: Params) => Promise<Record<string, unknown>>> = {
    async toggleAppearance(p) {
      const udid = udidParam(p);
      await requireDevice(udid);
      const next = (await getUiOption(udid, "appearance")).trim() === "dark" ? "light" : "dark";
      await setUiOption(udid, "appearance", next);
      return { appearance: next };
    },

    async home(p) {
      const udid = udidParam(p);
      const watch = p.watch === true;
      await requireDevice(udid);
      if (watch) return { ...(await run("osascript", WATCH_HOME_SCRIPT.flatMap((line) => ["-e", line]))) };
      return { ...(await run("xcrun", ["simctl", "launch", udid, "com.apple.springboard"])) };
    },

    async screenshot(p) {
      const udid = udidParam(p);
      const display = p.display === undefined ? undefined : enumParam(p, "display", DISPLAYS);
      await requireDevice(udid);
      const path = join(desktop(), `serve-sim-screenshot-${timestampSlug()}.png`);
      const r = await run("xcrun", [
        "simctl", "io", udid, "screenshot",
        ...(display ? [`--display=${display}`] : []),
        path,
      ]);
      return { ...r, path: r.exitCode === 0 ? path : "" };
    },

    async screenshotThumbnail(p) {
      const path = screenshotPathParam(p);
      const thumb = `/tmp/serve-sim-screenshot-thumb-${randomUUID()}.png`;
      try {
        const r = await run("sips", ["-Z", "320", path, "--out", thumb]);
        if (r.exitCode !== 0) return { data: "" };
        return { data: readFileSync(thumb).toString("base64") };
      } catch {
        return { data: "" };
      } finally {
        try { unlinkSync(thumb); } catch {}
      }
    },

    async revealScreenshot(p) {
      const path = screenshotPathParam(p);
      return { ...(await run("open", ["-R", path])) };
    },

    async revealApp(p) {
      const udid = udidParam(p);
      const bundleId = bundleIdParam(p);
      await requireDevice(udid);
      return { ...(await run("open", ["-R", await appContainer(udid, bundleId)])) };
    },

    async appDetails(p) {
      const udid = udidParam(p);
      const bundleId = bundleIdParam(p);
      await requireDevice(udid);
      const appPath = await appContainer(udid, bundleId);

      // Info.plist comes from the app bundle; like the icons below, only read
      // a regular file so a symlink can't point plutil at an arbitrary path.
      const plistPath = join(appPath, "Info.plist");
      let plistIsFile = false;
      try { plistIsFile = lstatSync(plistPath).isFile(); } catch {}
      const plist = plistIsFile
        ? await run("plutil", ["-convert", "json", "-o", "-", plistPath])
        : null;
      let info: any = {};
      if (plist?.exitCode === 0) {
        try { info = JSON.parse(plist.stdout); } catch {}
      }

      // CFBundleIcons → primary → CFBundleIconFiles last entry, falling back
      // to CFBundleIconFiles / CFBundleIconFile.
      let iconName: string | undefined;
      const primary = info?.CFBundleIcons?.CFBundlePrimaryIcon
        ?? info?.["CFBundleIcons~ipad"]?.CFBundlePrimaryIcon;
      const iconFiles: unknown = primary?.CFBundleIconFiles ?? info?.CFBundleIconFiles;
      if (Array.isArray(iconFiles) && iconFiles.length > 0) iconName = String(iconFiles[iconFiles.length - 1]);
      else if (typeof info?.CFBundleIconFile === "string") iconName = info.CFBundleIconFile;

      let iconDataUrl: string | null = null;
      // Icons are commonly compiled into Assets.car; loose PNGs may exist as
      // <icon>@2x.png / @3x.png. The name comes from the app's plist, so it
      // must stay a plain file name inside the bundle.
      if (iconName && !iconName.includes("/") && iconName !== "..") {
        const candidates = [
          `${iconName}@3x.png`,
          `${iconName}@2x.png`,
          `${iconName}.png`,
          `${iconName}60x60@3x.png`,
          `${iconName}60x60@2x.png`,
        ];
        for (const candidate of candidates) {
          try {
            const file = join(appPath, candidate);
            if (!lstatSync(file).isFile()) continue;
            iconDataUrl = `data:image/png;base64,${readFileSync(file).toString("base64")}`;
            break;
          } catch {}
        }
      }

      return {
        appPath,
        displayName: info.CFBundleDisplayName ?? info.CFBundleName,
        shortVersion: info.CFBundleShortVersionString,
        bundleVersion: info.CFBundleVersion,
        minOS: info.MinimumOSVersion,
        executable: info.CFBundleExecutable,
        iconDataUrl,
      };
    },

    async permissions(p) {
      const udid = udidParam(p);
      const bundleId = bundleIdParam(p);
      const action = enumParam(p, "action", PERMISSION_ACTIONS);
      const service = p.service;
      if (typeof service !== "string" || !(PERMISSION_NAMES.has(service) || (service === "all" && action === "reset"))) {
        fail("invalid service");
      }
      await requireDevice(udid);
      return { ...(await serveSim(["permissions", action, service, bundleId, "-d", udid])) };
    },

    async cameraListWebcams() {
      return { ...(await serveSim(["camera", "--list-webcams"])) };
    },

    async cameraInject(p) {
      const udid = udidParam(p);
      const bundleId = bundleIdParam(p);
      const source = enumParam(p, "source", CAMERA_SOURCES);
      const mirror = enumParam(p, "mirror", MIRROR_VALUES);
      const args = ["camera", bundleId, "-d", udid, "--quiet"];
      if (source === "image" || source === "video") {
        args.push("--file", cameraFileArg(p));
      } else if (source === "webcam") {
        const webcamId = webcamIdParam(p);
        args.push("--webcam", ...(webcamId ? [webcamId] : []));
      }
      args.push("--mirror", mirror);
      await requireDevice(udid);
      return { ...(await serveSim(args)) };
    },

    async cameraSwitch(p) {
      const udid = udidParam(p);
      const source = enumParam(p, "source", CAMERA_SOURCES);
      const isFile = source === "image" || source === "video";
      const args = ["camera", "switch", isFile ? "file" : source];
      if (source === "webcam") {
        const webcamId = webcamIdParam(p);
        if (webcamId) args.push(webcamId);
      }
      if (isFile) args.push(cameraFileArg(p));
      args.push("-d", udid, "--quiet");
      await requireDevice(udid);
      return { ...(await serveSim(args)) };
    },

    async cameraMirror(p) {
      const udid = udidParam(p);
      const mirror = enumParam(p, "mirror", MIRROR_VALUES);
      await requireDevice(udid);
      return { ...(await serveSim(["camera", "mirror", mirror, "-d", udid, "--quiet"])) };
    },

    async cameraStop(p) {
      const udid = udidParam(p);
      await requireDevice(udid);
      return { ...(await serveSim(["camera", "--stop-webcam", "-d", udid])) };
    },

    // Stage a dropped file under /tmp, one base64 slice per call. No shell:
    // the bytes go straight to an owner-only file that must not be a symlink.
    async uploadChunk(p) {
      const path = uploadPathParam(p);
      // An install upload is only ever consumed by installApp.
      if (!opts.allowExec && UPLOAD_PATH_RE.exec(path)![1] === "install") fail(INSTALL_REQUIRES_EXEC);
      const data = p.data;
      if (typeof data !== "string" || data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 || !BASE64_RE.test(data)) {
        fail("invalid data");
      }
      const bytes = Buffer.from(data, "base64");
      const { O_WRONLY, O_CREAT, O_EXCL, O_APPEND, O_NOFOLLOW } = fsConstants;
      const fd = openSync(
        path,
        p.append === true ? O_WRONLY | O_APPEND | O_NOFOLLOW : O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
        0o600,
      );
      try {
        if (fstatSync(fd).size + bytes.length > MAX_UPLOAD_BYTES) fail("File too large (max 500MB)");
        writeSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
      return { ok: true };
    },

    async uploadRemove(p) {
      const path = uploadPathParam(p);
      try { unlinkSync(path); } catch {}
      return { ok: true };
    },

    async addMedia(p) {
      const udid = udidParam(p);
      let path: string;
      try {
        path = uploadPathParam(p, "path", ["upload"]);
      } catch {
        path = screenshotPathParam(p);
      }
      await requireDevice(udid);
      return { ...(await run("xcrun", ["simctl", "addmedia", udid, path])) };
    },

    async installApp(p) {
      if (!opts.allowExec) fail(INSTALL_REQUIRES_EXEC);
      const udid = udidParam(p);
      const path = uploadPathParam(p, "path", ["install"]);
      if (!path.endsWith(".ipa")) fail("invalid path");
      await requireDevice(udid);
      return { ...(await run("xcrun", ["simctl", "install", udid, path])) };
    },

    // Set (lat/lng) or clear the simulated location.
    async location(p) {
      const udid = udidParam(p);
      const clear = p.lat === undefined && p.lng === undefined;
      const point = clear ? null : `${coordinate(p, "lat", 90).toFixed(7)},${coordinate(p, "lng", 180).toFixed(7)}`;
      await requireDevice(udid);
      return { ...(await run("xcrun", ["simctl", "location", udid, ...(point ? ["set", point] : ["clear"])])) };
    },
  };

  return async (payload) => {
    const { method, params } = (payload ?? {}) as { method?: unknown; params?: unknown };
    if (typeof method !== "string" || !Object.prototype.hasOwnProperty.call(methods, method)) {
      fail(`unknown method: ${String(method)}`);
    }
    const p = params && typeof params === "object" && !Array.isArray(params) ? (params as Params) : {};
    return methods[method]!(p);
  };
}
