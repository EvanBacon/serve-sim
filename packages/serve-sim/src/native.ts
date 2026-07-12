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

const require = createRequire(import.meta.url);

// The addon exposes two NodeClasses (SimHID, SimCapture) plus two async
// functions. NodeClass instances clean up their native resources when the JS
// handle is garbage-collected (Swift `deinit`), so there are no explicit
// destroy/free calls here.
interface SimHIDHandle {
  touch(type: TouchType, x: number, y: number, w: number, hh: number, edge: number): Promise<void>;
  multiTouch(type: TouchType, x1: number, y1: number, x2: number, y2: number, w: number, hh: number): Promise<void>;
  button(button: string): Promise<void>;
  buttonHid(page: number, usage: number, phase: ButtonPhase): Promise<void>;
  key(type: KeyType, usage: number): Promise<void>;
  scroll(dx: number, dy: number, anchorX: number, anchorY: number, w: number, hh: number): Promise<void>;
  digitalCrown(delta: number): Promise<void>;
  orientation(orientation: number): Promise<boolean>;
  memoryWarning(): Promise<void>;
  softwareKeyboard(): Promise<void>;
  caDebug(name: string, enabled: boolean): Promise<boolean>;
}

interface SimCaptureHandle {
  start(): void;
  stop(): void;
  subscribe(codec: number, onFrame: RawFrameCallback): Promise<() => void>;
}

interface NativeAddon {
  SimHID: new (udid: string) => SimHIDHandle;
  SimCapture: new (udid: string) => SimCaptureHandle;
  axDescribe(udid: string): Promise<string>;
  axFrontmost(udid: string): Promise<string>;
}

// (codec, data, width, height, flags) — codec 0=MJPEG 1=AVCC; flags bit0=desc bit1=keyframe.
type RawFrameCallback = (
  data: Uint8Array,
  width: number,
  height: number,
  flags: number,
) => Promise<void>;

const CODEC_MJPEG = 0;
const CODEC_AVCC = 1;
const FLAG_DESCRIPTION = 1 << 0;
const FLAG_KEYFRAME = 1 << 1;

export type MjpegFrame = {
  data: Uint8Array;
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

export type TouchType = "begin" | "move" | "end";
export type KeyType = "down" | "up";
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
    // arm64-only (Apple Silicon); loaded by path so it works under npx, the
    // compiled binary, and the dev server alike.
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

let addon: NativeAddon | undefined;
function load(): NativeAddon {
  if (!addon) addon = require(resolveAddon()) as NativeAddon;
  return addon;
}

/**
 * In-process HID injector for one simulator. Mirrors the WebSocket HID protocol
 * the spawned helper used to handle, but as direct native calls.
 */
export class NativeHid {
  private readonly handle: SimHIDHandle;

  constructor(udid: string) {
    this.handle = new (load().SimHID)(udid);
  }

  // The N-API bindings throw synchronously when a JS value can't be coerced to
  // the native parameter type (e.g. a touch with a non-string `type` →
  // "Could not convert parameter 0 to type String"). HID now runs in-process,
  // so an unhandled throw here crashes the whole server — and if it lands
  // mid-gesture, the guest is left with a stuck finger that wedges input until
  // the sim reboots. The spawned helper used to absorb this in its own process;
  // `guard` restores that isolation by swallowing malformed-input errors.
  private async guard<T>(op: string, fn: () => PromiseLike<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      console.error(`[hid] ${op} ignored bad input:`, err instanceof Error ? err.message : err);
      return fallback;
    }
  }

  touch(type: TouchType, x: number, y: number, w: number, h: number, edge = 0): Promise<void> {
    return this.guard("touch", () => this.handle.touch(type, x, y, w, h, edge), undefined);
  }

  multiTouch(type: TouchType, x1: number, y1: number, x2: number, y2: number, w: number, h: number): Promise<void> {
    return this.guard("multiTouch", () => this.handle.multiTouch(type, x1, y1, x2, y2, w, h), undefined);
  }

  button(button: string): Promise<void> {
    return this.guard("button", () => this.handle.button(button), undefined);
  }

  buttonHid(page: number, usage: number, phase: ButtonPhase = "press"): Promise<void> {
    return this.guard("buttonHid", () => this.handle.buttonHid(page, usage, phase), undefined);
  }

  key(type: KeyType, usage: number): Promise<void> {
    return this.guard("key", () => this.handle.key(type, usage), undefined);
  }

  /** anchorX/anchorY default to screen center when omitted. */
  scroll(dx: number, dy: number, w: number, h: number, anchorX?: number, anchorY?: number): Promise<void> {
    return this.guard("scroll", () => this.handle.scroll(dx, dy, anchorX ?? NaN, anchorY ?? NaN, w, h), undefined);
  }

  digitalCrown(delta: number): Promise<void> {
    return this.guard("digitalCrown", () => this.handle.digitalCrown(delta), undefined);
  }

  orientation(orientation: number): Promise<boolean> {
    return this.guard("orientation", () => this.handle.orientation(orientation), false);
  }

  memoryWarning(): Promise<void> {
    return this.guard("memoryWarning", () => this.handle.memoryWarning(), undefined);
  }

  softwareKeyboard(): Promise<void> {
    return this.guard("softwareKeyboard", () => this.handle.softwareKeyboard(), undefined);
  }

  caDebug(name: string, enabled: boolean): Promise<boolean> {
    return this.guard("caDebug", () => this.handle.caDebug(name, enabled), false);
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

  constructor(udid: string) {
    this.handle = new (load().SimCapture)(udid);
  }

  /** Begin capturing. Throws if the device isn't booted. */
  start(): void {
    this.handle.start();
  }

  subscribeMjpeg(onFrame: (frame: MjpegFrame) => Promise<void>): Promise<() => void> {
    return this.handle.subscribe(CODEC_MJPEG, (data, width, height, _flags) => {
      return onFrame({ data, width, height });
    });
  }

  subscribeAvcc(onFrame: (frame: AvccFrame) => Promise<void>): Promise<() => void> {
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

  /** Halt frame production. Full teardown happens when this object is GC'd. */
  stop(): void {
    this.handle.stop();
  }
}

/**
 * Async accessibility-tree dump for `udid`, as an axe-shaped JSON string (the
 * src/ax.ts normalizer consumes it unchanged). Runs native AX work off the JS
 * event loop. Rejects if the sim's AX service isn't reachable yet.
 */
export function axDescribeAsync(udid: string): Promise<string> {
  return load().axDescribe(udid);
}

/** Async frontmost-app probe — JSON string `{ bundleId, pid }` for the visible app. */
export function axFrontmostAsync(udid: string): Promise<string> {
  return load().axFrontmost(udid);
}
