/**
 * Typed loader + wrapper for serve-sim-native.node — the in-process N-API addon
 * that replaces the spawned serve-sim-bin helper. HID is the first surface;
 * frame capture + encoders land here next.
 *
 * The .node is resolved from disk (dist/native/) relative to either this module
 * or the bun-compiled executable, so it loads under `npx serve-sim`, the
 * compiled binary, and the mounted middleware alike.
 */
import { createRequire } from "module";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { KeySequencer, type KeyType } from "./key-sequencer";
import { launchableHelper } from "./launchable-helper";
import { maxBitrateFromEnv } from "./max-bitrate";
import { resolveDeviceSet } from "./simctl";

export type { KeyType } from "./key-sequencer";

const require = createRequire(import.meta.url);

// The addon exposes two NodeClasses (SimHID, SimCapture) plus two async
// functions. NodeClass instances clean up their native resources when the JS
// handle is garbage-collected (Swift `deinit`), so there are no explicit
// destroy/free calls here.
interface SimHIDHandle {
  /** Resolves whether the event reached the HID client (addons before #136 resolve undefined). */
  touch(type: TouchType, x: number, y: number, w: number, hh: number, edge: number): Promise<boolean | void>;
  multiTouch(type: TouchType, x1: number, y1: number, x2: number, y2: number, w: number, hh: number): Promise<boolean | void>;
  button(button: string): Promise<boolean | void>;
  buttonHid(page: number, usage: number, phase: ButtonPhase): Promise<boolean | void>;
  key(type: KeyType, usage: number): Promise<void>;
  scroll(dx: number, dy: number, anchorX: number, anchorY: number, w: number, hh: number): Promise<void>;
  digitalCrown(delta: number): Promise<void>;
  orientation(orientation: number): Promise<boolean>;
  memoryWarning(): Promise<void>;
  softwareKeyboard(): Promise<void>;
  caDebug(name: string, enabled: boolean): Promise<boolean>;
  hardwareKeyboard(enabled: boolean): Promise<boolean>;
  isFoldable(): Promise<boolean>;
  /** Swap the helper the Duo bridge launches; a no-op on other devices. */
  setDuoHelper(path: string): Promise<void>;
  close(): Promise<void>;
  pose(name: string, fromDegrees: number): Promise<boolean>;
  hinge(degrees: number): Promise<boolean>;
}

interface SimCaptureHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  setPreferredScreenSize(width: number, height: number): Promise<void>;
  subscribe(codec: number, onFrame: RawFrameCallback): Promise<() => void | Promise<void>>;
  /** Absent in addons built before diagnostics existed. */
  diagnostics?(): Promise<string>;
  /** Content-changed frame count (a lock read). Absent in older addons. */
  contentChangeCount?(): number;
  snapshotJpeg(): Promise<Uint8Array | null>;
  /** Downscaled JPEG for the rolling buffer. Absent in older addons. */
  thumbnailJpeg?(maxDimension: number, quality: number): Promise<ThumbnailJpeg | null>;
  /** Absent in addons built before screen recording existed. */
  startRecording?(path: string, codec: string, fps: number, rotation: number, bitrate: number, index: boolean): Promise<void>;
  stopRecording?(): Promise<string>;
}

interface NativeAddon {
  SimHID: new (udid: string, duoHelper: string) => SimHIDHandle;
  /** maxBitrate: H.264 cap in bits/s, or null for the resolution-scaled default. */
  SimCapture: new (udid: string, maxBitrate: number | null) => SimCaptureHandle;
  /** discovery "agent": faster grid discovery for /ax/snapshot; omitted keeps /ax output. */
  axDescribe(udid: string, discovery?: AxDiscovery): Promise<string>;
  axFrontmost(udid: string): Promise<string>;
  setDeviceSet(path: string | null): void;
  /** Absent in addons built before `record frame|diff` existed. */
  videoInfo?(path: string): Promise<string>;
  videoFrame?(path: string, seconds: number): Promise<VideoFrame>;
}

/** A local movie's video track, read without decoding. */
export type VideoInfo = {
  /** Container duration, seconds. */
  duration: number;
  /** Displayed size (track transform applied). */
  width: number;
  height: number;
  /** Presentation time of every sample, ascending, seconds. */
  sampleTimes: number[];
};

/** One decoded sample: tightly packed RGBA (alpha 255), top row first. */
export type VideoFrame = { width: number; height: number; time: number; rgba: Uint8Array };

// (data, width, height, flags) — codec 0=MJPEG 1=AVCC 2=size-only; flags bit0=desc bit1=keyframe.
type RawFrameCallback = (
  data: Uint8Array,
  width: number,
  height: number,
  flags: number,
) => Promise<void>;

const CODEC_MJPEG = 0;
const CODEC_AVCC = 1;
const CODEC_SIZE = 2;
const FLAG_DESCRIPTION = 1 << 0;
const FLAG_KEYFRAME = 1 << 1;

/** A downscaled still of the current screen (`thumbnailJpeg`). */
export type ThumbnailJpeg = {
  data: Uint8Array;
  width: number;
  height: number;
  /** The captured framebuffer's size. */
  sourceWidth: number;
  sourceHeight: number;
};

export type MjpegFrame = {
  data: Uint8Array;
  width: number;
  height: number;
};

export type ScreenSize = {
  width: number;
  height: number;
};

export type AvccFrame = {
  data: Uint8Array;
  width: number;
  height: number;
  isDescription: boolean;
  isKeyframe: boolean;
};

export type RecordingCodec = "h264" | "hevc";

export type RecordingStartOptions = {
  codec: RecordingCodec;
  /** Constant output frame rate; static stretches repeat the last frame. */
  fps: number;
  /** Clockwise display rotation stored as the MP4 track transform. */
  rotation: number;
  /** Average bits/s; omitted picks the resolution-scaled default. */
  bitrate?: number;
  /**
   * Collect per-sample metadata for the `.index.jsonl` sidecar (added to the
   * finish summary as `index`). Off unless requested.
   */
  index?: boolean;
};

/** JSON summary the native recorder returns when a recording is finalized. */
export type RecordingSummary = {
  path: string;
  width: number;
  height: number;
  fps: number;
  codec?: RecordingCodec;
  bitrate?: number;
  rotation?: number;
  /** Frames in the file (CFR: duration × fps). */
  frames: number;
  duration: number;
  /** Frames delivered by capture while recording. */
  captured?: number;
  /** Captured frames written at their own slot. */
  encoded?: number;
  /** Slots filled by repeating the previous frame (static screen). */
  repeated?: number;
  /** Captured frames skipped (faster than fps, or a mid-recording size change). */
  dropped?: number;
  /** Of `dropped`, frames shed because the encoder backlog was full. */
  backlogDropped?: number;
  startedAt?: string;
};

export type TouchType = "begin" | "move" | "end";
export type ButtonPhase = "down" | "up" | "press";

/** UIDeviceOrientation values the simulator's GraphicsServices accepts. */
export const Orientation = {
  portrait: 1,
  portraitUpsideDown: 2,
  landscapeRight: 3,
  landscapeLeft: 4,
} as const;

function resolveAddon(): string {
  const candidates = [
    // Beside the bun-compiled executable (dist/serve-sim → dist/native/…).
    // Universal by default (SERVE_SIM_ARCH); loaded by path so it works under
    // npx, the compiled binary, and the dev server alike.
    join(dirname(process.execPath), "native", "serve-sim-native.node"),
    // Beside the bundled JS (dist/serve-sim.js or dist/middleware.js).
    join(dirname(fileURLToPath(import.meta.url)), "native", "serve-sim-native.node"),
    // Dev: running from source (src/native.ts → ../dist/native/…).
    join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "native", "serve-sim-native.node"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `serve-sim-native.node not found. Looked in:\n  ${candidates.join("\n  ")}\n` +
      "Run `bun run build.ts` to build the native addon.",
  );
}

/** The guest-side Duo helper as bundled, without checking that it launches. */
function bundledDuoHidHelperPath(): string {
  return join(dirname(resolveAddon()), "..", "simduo", "serve-sim-duo-hid");
}

let duoHidHelper: string | undefined;
/**
 * The guest-side Duo helper (`simctl spawn`): HID commands and the hinge reader.
 * A hardened-runtime re-signed bundle resolves to a copy dyld can launch.
 * Resolving runs a blocking `codesign` probe, so only call it for an iPhone Duo.
 */
export function duoHidHelperPath(): string {
  return duoHidHelper ??= launchableHelper(bundledDuoHidHelperPath());
}

let addon: NativeAddon | undefined;
function load(): NativeAddon {
  if (!addon) {
    addon = require(resolveAddon()) as NativeAddon;
    // The addon cannot read the set from the environment: under Bun a
    // `process.env` write never reaches it.
    addon.setDeviceSet(resolveDeviceSet() ?? null);
  }
  return addon;
}

// How long a new HID client is given before touch/button input is sent to it.
// A heuristic, not a guarantee: measured on iOS 27.2 from only a few runs (a tap
// 0.5s after the session was created landed 1/2 times; at 1.5s, 2/2 and every
// later tap landed). If the first tap after a fresh start is flaky on a slower
// machine or runtime, suspect this value first.
const GUEST_HID_SETTLE_MS = 1_500;

/**
 * In-process HID injector for one simulator. Mirrors the WebSocket HID protocol
 * the spawned helper used to handle, but as direct native calls.
 */
export interface NativeHidDeps {
  SimHID?: NativeAddon["SimHID"];
  /** The helper as bundled; must be cheap. */
  bundledDuoHelper?: () => string;
  /** The launchable helper; may run `codesign`, so it is only called for a Duo. */
  duoHelper?: () => string;
  /** Frontmost-app probe; defaults to `axFrontmostAsync`. */
  axFrontmost?: (udid: string) => Promise<string>;
  /** Guest UI orientation name (`portrait`, `landscape_left`, …). */
  getOrientation?: () => string | undefined;
  /** True only for Face ID / home-indicator devices with known chrome. */
  supportsHomeIndicator?: () => boolean;
  /** Last known Device Hub legacy-input shadow flag. */
  isInputShadowed?: () => boolean;
}

export const SPRINGBOARD_BUNDLE_ID = "com.apple.springboard";

/** Bound on the frontmost probe that chooses launch vs flick. */
export const HOME_FRONTMOST_PROBE_TIMEOUT_MS = 400;

const PORTRAIT_ORIENTATIONS = new Set(["portrait", "portrait_upside_down"]);

export type HomeButtonRoute = {
  bundleId?: string | null;
  supportsHomeIndicator?: boolean;
  orientation?: string | null;
  inputShadowed?: boolean;
};

/**
 * `hid.button("home")` launches SpringBoard to leave a foreground app (the
 * Indigo HID home press is dropped on Xcode 26+). That launch is a no-op when
 * SpringBoard is already frontmost, so App Library, folders, and inner home
 * pages on Face ID devices in portrait use a short home-indicator flick
 * instead of `swipe_home` (a long swipe can open the app switcher on page 1).
 * Home-button devices, landscape, Device Hub shadow, and an unknown
 * frontmost/orientation all stay on the launch path: a bottom-edge swipe on
 * those surfaces can open Control Center or miss the home indicator.
 */
export function homeButtonForFrontmost(route: HomeButtonRoute): "home" | "flick_home" {
  if (route.bundleId !== SPRINGBOARD_BUNDLE_ID) return "home";
  if (route.inputShadowed) return "home";
  if (route.supportsHomeIndicator !== true) return "home";
  if (route.orientation == null || !PORTRAIT_ORIENTATIONS.has(route.orientation)) return "home";
  return "flick_home";
}

/** Session fields as NativeHid should see them. Unknown orientation, an
 *  unsettled Device Hub probe (`undefined`), or an unconfirmed chrome/
 *  foldable flag must not flick. */
export function homeButtonSessionRoute(state: {
  knownOrientation?: string;
  deviceHubShadowed?: boolean;
  homeIndicatorFlickSupported?: boolean;
}): Pick<HomeButtonRoute, "supportsHomeIndicator" | "orientation" | "inputShadowed"> {
  return {
    supportsHomeIndicator: state.homeIndicatorFlickSupported === true,
    orientation: state.knownOrientation,
    inputShadowed: state.deviceHubShadowed !== false,
  };
}

function canFlickHomeBeforeFrontmostProbe(route: Pick<HomeButtonRoute, "supportsHomeIndicator" | "orientation" | "inputShadowed">): boolean {
  return homeButtonForFrontmost({ ...route, bundleId: SPRINGBOARD_BUNDLE_ID }) === "flick_home";
}

export class NativeHid {
  private readonly udid: string;
  private readonly axFrontmost: (udid: string) => Promise<string>;
  private readonly getOrientation: () => string | undefined;
  private readonly supportsHomeIndicator: () => boolean;
  private readonly isInputShadowed: () => boolean;
  private readonly handle: SimHIDHandle;
  private readonly keys: KeySequencer;
  /**
   * Resolves once HID setup finished and the guest had time to pick up the
   * new HID client. A brand-new SimDeviceLegacyHIDClient accepts messages
   * (the send completion reports no error) but the guest ignores input for
   * roughly the first second, so `serve-sim tap` right after a fresh start
   * was silently dropped (#136). Touch/button input waits on this one shared
   * promise; JS resolves its waiters in FIFO order, so a tap's begin/end can't
   * be reordered. Later input passes through immediately.
   */
  private readonly ready: Promise<void>;
  /** Settles once a Duo's bridge points at the launchable helper. */
  private readonly duoHelperReady: Promise<void>;
  private duoHelperSettled = false;

  constructor(udid: string, deps: NativeHidDeps = {}) {
    this.udid = udid;
    this.axFrontmost = deps.axFrontmost ?? axFrontmostAsync;
    this.getOrientation = deps.getOrientation ?? (() => undefined);
    this.supportsHomeIndicator = deps.supportsHomeIndicator ?? (() => false);
    this.isInputShadowed = deps.isInputShadowed ?? (() => false);
    const bundled = (deps.bundledDuoHelper ?? bundledDuoHidHelperPath)();
    this.handle = new (deps.SimHID ?? load().SimHID)(udid, bundled);
    this.keys = new KeySequencer(this.handle);
    const setup = this.handle.isFoldable();
    this.ready = setup.then(
      () => new Promise<void>((resolve) => setTimeout(resolve, GUEST_HID_SETTLE_MS).unref?.()),
      () => {}, // setup failed: let the sends run so they report the failure
    );
    const resolve = deps.duoHelper ?? duoHidHelperPath;
    this.duoHelperReady = setup.then(async (foldable) => {
      if (!foldable) return;
      const helper = resolve();
      if (helper !== bundled) await this.handle.setDuoHelper(helper);
    }).catch(() => {}).finally(() => { this.duoHelperSettled = true; });
  }

  private async settled<T>(fn: () => PromiseLike<T>): Promise<T> {
    await this.ready;
    return fn();
  }

  /**
   * Commands a Duo routes through its guest helper wait for it to be resolved.
   * Once it has been, they run immediately so they keep their order relative
   * to touches and keys sent in the same tick.
   */
  private viaDuoHelper<T>(fn: () => PromiseLike<T>): () => PromiseLike<T> {
    return () => (this.duoHelperSettled ? fn() : this.duoHelperReady.then(fn));
  }

  // The N-API bindings throw synchronously when a JS value can't be coerced to
  // the native parameter type (e.g. a touch with a non-string `type` →
  // "Could not convert parameter 0 to type String"). HID now runs in-process,
  // so an unhandled throw here crashes the whole server — and if it lands
  // mid-gesture, the guest is left with a stuck finger that wedges input until
  // the sim reboots. The spawned helper used to absorb this in its own process;
  // `guard` restores that isolation by swallowing malformed-input errors (and
  // HID setup failures, which every input method now awaits).
  private async guard<T>(op: string, fn: () => PromiseLike<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      console.error(`[hid] ${op} failed:`, err instanceof Error ? err.message : err);
      return fallback;
    }
  }

  // The sends below resolve whether the injector handed the event to the
  // guest: false when it couldn't (HID setup failed, message builder missing,
  // unknown button) so `serve-sim tap/button/gesture/type` can exit non-zero (#136).

  touch(type: TouchType, x: number, y: number, w: number, h: number, edge = 0): Promise<boolean> {
    return this.delivered("touch", () => this.settled(() => this.handle.touch(type, x, y, w, h, edge)));
  }

  multiTouch(type: TouchType, x1: number, y1: number, x2: number, y2: number, w: number, h: number): Promise<boolean> {
    return this.delivered("multiTouch", () => this.settled(() => this.handle.multiTouch(type, x1, y1, x2, y2, w, h)));
  }

  async button(button: string): Promise<boolean> {
    if (button !== "home") {
      return this.delivered("button", () => this.settled(this.viaDuoHelper(() => this.handle.button(button))));
    }
    const name = await this.homeButtonName();
    const send = this.viaDuoHelper(() => this.handle.button(name));
    // SpringBoardLauncher does not use the HID client, so a cold session
    // must not wait out GUEST_HID_SETTLE_MS and then trip the host-rpc
    // timeout (which would also fire a late flick after simctl fallback).
    if (name === "home") return this.delivered("button", send);
    return this.delivered("button", () => this.settled(send));
  }

  private async homeButtonName(): Promise<"home" | "flick_home"> {
    const gates = {
      supportsHomeIndicator: this.supportsHomeIndicator(),
      orientation: this.getOrientation(),
      inputShadowed: this.isInputShadowed(),
    };
    // Sync gates already rule out a flick: skip the AX probe (up to 400 ms)
    // on home-button devices, landscape, unknown orientation, and shadow.
    if (!canFlickHomeBeforeFrontmostProbe(gates)) return "home";
    let bundleId: string | null = null;
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("axFrontmost timeout")), HOME_FRONTMOST_PROBE_TIMEOUT_MS);
        timer.unref?.();
        this.axFrontmost(this.udid).then(
          (value) => { clearTimeout(timer); resolve(value); },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });
      bundleId = (JSON.parse(raw) as { bundleId?: string }).bundleId ?? null;
    } catch {
      return "home";
    }
    return homeButtonForFrontmost({ bundleId, ...gates });
  }

  buttonHid(page: number, usage: number, phase: ButtonPhase = "press"): Promise<boolean> {
    return this.delivered("buttonHid", () => this.settled(this.viaDuoHelper(() => this.handle.buttonHid(page, usage, phase))));
  }

  private async delivered(op: string, fn: () => PromiseLike<boolean | void>): Promise<boolean> {
    return (await this.guard<boolean | void>(op, fn, false)) !== false;
  }

  key(type: KeyType, usage: number): Promise<boolean> {
    return this.delivered("key", () => this.keys.key(type, usage));
  }

  /** anchorX/anchorY default to screen center when omitted. */
  scroll(dx: number, dy: number, w: number, h: number, anchorX?: number, anchorY?: number): Promise<boolean> {
    return this.delivered("scroll", () => this.settled(() => this.handle.scroll(dx, dy, anchorX ?? NaN, anchorY ?? NaN, w, h)));
  }

  digitalCrown(delta: number): Promise<boolean> {
    return this.delivered("digitalCrown", () => this.settled(() => this.handle.digitalCrown(delta)));
  }

  orientation(orientation: number): Promise<boolean> {
    return this.guard("orientation", this.viaDuoHelper(() => this.handle.orientation(orientation)), false);
  }

  memoryWarning(): Promise<void> {
    return this.guard("memoryWarning", () => this.handle.memoryWarning(), undefined);
  }

  softwareKeyboard(): Promise<void> {
    return this.guard("softwareKeyboard", () => this.settled(() => this.handle.softwareKeyboard()), undefined);
  }

  caDebug(name: string, enabled: boolean): Promise<boolean> {
    return this.guard("caDebug", () => this.handle.caDebug(name, enabled), false);
  }

  hardwareKeyboard(enabled: boolean): Promise<boolean> {
    return this.guard("hardwareKeyboard", () => this.handle.hardwareKeyboard(enabled), false);
  }

  isFoldable(): Promise<boolean> {
    return this.guard("isFoldable", () => this.handle.isFoldable(), false);
  }

  close(): Promise<void> {
    return this.keys.drainAndRelease();
  }

  pose(name: string, fromDegrees: number): Promise<boolean> {
    return this.guard("pose", this.viaDuoHelper(() => this.handle.pose(name, fromDegrees)), false);
  }

  hinge(degrees: number): Promise<boolean> {
    return this.guard("hinge", this.viaDuoHelper(() => this.handle.hinge(degrees)), false);
  }
}

/**
 * In-process frame capture + encode for one simulator. Replaces the spawned
 * helper's capture pipeline. MJPEG and H.264/AVCC frames are produced while
 * callers hold codec-specific subscriptions; encoded frames arrive on the JS
 * thread after being marshalled from the native encode thread.
 */
export class NativeCapture {
  private readonly handle: SimCaptureHandle;

  constructor(udid: string, maxBitrate: number | undefined = maxBitrateFromEnv()) {
    this.handle = new (load().SimCapture)(udid, maxBitrate ?? null);
  }

  /** Begin capturing. Rejects if the device isn't booted. */
  start(): Promise<void> {
    return this.handle.start();
  }

  /** Pin capture to one native display (e.g. Duo cover vs inner). 0×0 clears. */
  setPreferredScreenSize(width: number, height: number): Promise<void> {
    return this.handle.setPreferredScreenSize(width, height);
  }

  subscribeMjpeg(onFrame: (frame: MjpegFrame) => Promise<void>): Promise<() => void | Promise<void>> {
    return this.handle.subscribe(CODEC_MJPEG, (data, width, height, _flags) => {
      return onFrame({ data, width, height });
    });
  }

  subscribeAvcc(onFrame: (frame: AvccFrame) => Promise<void>): Promise<() => void | Promise<void>> {
    return this.handle.subscribe(CODEC_AVCC, (data, width, height, flags) => {
      return onFrame({
        data,
        width,
        height,
        isDescription: (flags & FLAG_DESCRIPTION) !== 0,
        isKeyframe: (flags & FLAG_KEYFRAME) !== 0,
      });
    });
  }

  /** JSON: display candidates + selection reason, surface-size history, encoder sessions and error counts. */
  diagnostics(): Promise<string> {
    if (!this.handle.diagnostics) return Promise.reject(new Error("native capture diagnostics unavailable in this build"));
    return this.handle.diagnostics();
  }

  /**
   * Captured frames whose IOSurface content changed (idle re-emits excluded),
   * or null with an addon that predates the counter. Cheap enough to poll:
   * it reads one locked integer, unlike `diagnostics()`.
   */
  contentChangeCount(): number | null {
    return this.handle.contentChangeCount ? this.handle.contentChangeCount() : null;
  }

  /**
   * Screen size with the first frame after subscribing and on every change. Encodes
   * nothing, so a session can track dimensions without paying for JPEG or
   * H.264 work while nobody is watching.
   */
  subscribeSize(onSize: (size: ScreenSize) => void | Promise<void>): Promise<() => void | Promise<void>> {
    return this.handle.subscribe(CODEC_SIZE, async (_data, width, height) => {
      await onSize({ width, height });
    });
  }

  /** JPEG of the latest frame, encoded on demand; null before the first frame. */
  snapshotJpeg(): Promise<Uint8Array | null> {
    return this.handle.snapshotJpeg();
  }

  /**
   * JPEG of the latest frame downscaled to fit `maxDimension` on the long
   * edge (for the opt-in rolling buffer); null before the first frame.
   * Encodes on its own utility queue, only when called.
   */
  thumbnailJpeg(maxDimension: number, quality: number): Promise<ThumbnailJpeg | null> {
    if (!this.handle.thumbnailJpeg) return Promise.reject(new Error("thumbnails unavailable in this native build; rebuild serve-sim (bun run build.ts)"));
    return this.handle.thumbnailJpeg(maxDimension, quality);
  }

  /** False when the addon predates `thumbnailJpeg` (the rolling buffer). */
  get supportsThumbnails(): boolean {
    return typeof this.handle.thumbnailJpeg === "function";
  }

  /** False for addons built before screen recording existed. */
  get supportsRecording(): boolean {
    return typeof this.handle.startRecording === "function" && typeof this.handle.stopRecording === "function";
  }

  /**
   * Start recording the screen to an MP4 at `path`: native resolution,
   * hardware H.264/HEVC straight from the captured frames (no stream
   * re-encode), placed on a constant `fps` grid by capture time.
   */
  startRecording(path: string, options: RecordingStartOptions): Promise<void> {
    if (!this.handle.startRecording) return Promise.reject(new Error("screen recording unavailable in this native build"));
    return this.handle.startRecording(path, options.codec, options.fps, options.rotation, options.bitrate ?? 0, options.index === true);
  }

  /** Finalize the active recording; resolves with its JSON summary string. */
  stopRecording(): Promise<string> {
    if (!this.handle.stopRecording) return Promise.reject(new Error("screen recording unavailable in this native build"));
    return this.handle.stopRecording();
  }

  /** Halt frame production. Full teardown happens when this object is GC'd. */
  stop(): Promise<void> {
    return this.handle.stop();
  }
}

/**
 * How the native bridge looks for elements its tree walk misses.
 * "exhaustive" (default) is the `/ax` output the web UI overlay uses; "agent"
 * skips hit-test probes inside wide childless controls away from the screen
 * edges and strides over background (~2-4x faster) for the agent snapshot
 * path. See Sources/SimNativeSupport/AccessibilityDiscovery.swift.
 */
export type AxDiscovery = "exhaustive" | "agent";

/**
 * Async accessibility-tree dump for `udid`, as an axe-shaped JSON string (the
 * src/ax.ts normalizer consumes it unchanged). Runs native AX work off the JS
 * event loop. Rejects if the sim's AX service isn't reachable yet.
 */
export function axDescribeAsync(udid: string, discovery: AxDiscovery = "exhaustive"): Promise<string> {
  return discovery === "agent" ? load().axDescribe(udid, discovery) : load().axDescribe(udid);
}

/** Async frontmost-app probe — JSON string `{ bundleId, pid }` for the visible app. */
export function axFrontmostAsync(udid: string): Promise<string> {
  return load().axFrontmost(udid);
}

const NO_VIDEO_READS = "reading recordings is unavailable in this native build; rebuild serve-sim (bun run build.ts)";

/** Sample times, duration and size of a local MP4/MOV (AVFoundation, off the JS thread). */
export async function readVideoInfo(path: string): Promise<VideoInfo> {
  const native = load();
  if (!native.videoInfo) throw new Error(NO_VIDEO_READS);
  return JSON.parse(await native.videoInfo(path)) as VideoInfo;
}

/**
 * Decode the sample shown at `seconds` (zero tolerance, track transform
 * applied). A time exactly on a sample boundary can resolve to the previous
 * sample, so callers ask for the middle of the sample they want.
 */
export async function readVideoFrame(path: string, seconds: number): Promise<VideoFrame> {
  const native = load();
  if (!native.videoFrame) throw new Error(NO_VIDEO_READS);
  return native.videoFrame(path, seconds);
}
