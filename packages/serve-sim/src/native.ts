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
  touch(type: TouchType, x: number, y: number, w: number, hh: number, edge: number): void;
  multiTouch(type: TouchType, x1: number, y1: number, x2: number, y2: number, w: number, hh: number): void;
  button(button: string): void;
  buttonHid(page: number, usage: number, phase: ButtonPhase): void;
  key(type: KeyType, usage: number): void;
  scroll(dx: number, dy: number, anchorX: number, anchorY: number, w: number, hh: number): void;
  digitalCrown(delta: number): void;
  orientation(orientation: number): boolean;
  memoryWarning(): void;
  softwareKeyboard(): void;
  caDebug(name: string, enabled: boolean): boolean;
}

interface SimCaptureHandle {
  start(): void;
  setAvccActive(active: boolean): void;
  requestKeyframe(): void;
  screenSize(): { width: number; height: number };
  stop(): void;
}

interface NativeAddon {
  SimHID: new (udid: string) => SimHIDHandle;
  SimCapture: new (udid: string, onFrame: RawFrameCallback) => SimCaptureHandle;
  axDescribe(udid: string): Promise<string>;
  axFrontmost(udid: string): Promise<string>;
}

// (codec, data, width, height, flags) — codec 0=MJPEG 1=AVCC; flags bit0=desc bit1=keyframe.
type RawFrameCallback = (codec: number, data: Buffer, width: number, height: number, flags: number) => void;

const CODEC_AVCC = 1;
const FLAG_DESCRIPTION = 1 << 0;
const FLAG_KEYFRAME = 1 << 1;

export interface NativeFrame {
  /** `mjpeg` = a full JPEG; `avcc` = a length-prefixed AVCC envelope chunk. */
  codec: "mjpeg" | "avcc";
  /** Encoded bytes, ready to write to the stream wire. */
  data: Buffer;
  width: number;
  height: number;
  /** AVCC only: this chunk is the avcC parameter-set blob (decoder config). */
  isDescription: boolean;
  /** AVCC only: this chunk is an IDR keyframe (a decoder can start here). */
  isKeyframe: boolean;
}

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
  private guard<T>(op: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      console.error(`[hid] ${op} ignored bad input:`, err instanceof Error ? err.message : err);
      return fallback;
    }
  }

  touch(type: TouchType, x: number, y: number, w: number, h: number, edge = 0): void {
    this.guard("touch", () => this.handle.touch(type, x, y, w, h, edge), undefined);
  }

  multiTouch(type: TouchType, x1: number, y1: number, x2: number, y2: number, w: number, h: number): void {
    this.guard("multiTouch", () => this.handle.multiTouch(type, x1, y1, x2, y2, w, h), undefined);
  }

  button(button: string): void {
    this.guard("button", () => this.handle.button(button), undefined);
  }

  buttonHid(page: number, usage: number, phase: ButtonPhase = "press"): void {
    this.guard("buttonHid", () => this.handle.buttonHid(page, usage, phase), undefined);
  }

  key(type: KeyType, usage: number): void {
    this.guard("key", () => this.handle.key(type, usage), undefined);
  }

  /** anchorX/anchorY default to screen center when omitted. */
  scroll(dx: number, dy: number, w: number, h: number, anchorX?: number, anchorY?: number): void {
    this.guard("scroll", () => this.handle.scroll(dx, dy, anchorX ?? NaN, anchorY ?? NaN, w, h), undefined);
  }

  digitalCrown(delta: number): void {
    this.guard("digitalCrown", () => this.handle.digitalCrown(delta), undefined);
  }

  orientation(orientation: number): boolean {
    return this.guard("orientation", () => this.handle.orientation(orientation), false);
  }

  memoryWarning(): void {
    this.guard("memoryWarning", () => this.handle.memoryWarning(), undefined);
  }

  softwareKeyboard(): void {
    this.guard("softwareKeyboard", () => this.handle.softwareKeyboard(), undefined);
  }

  caDebug(name: string, enabled: boolean): boolean {
    return this.guard("caDebug", () => this.handle.caDebug(name, enabled), false);
  }
}

/**
 * In-process frame capture + encode for one simulator. Replaces the spawned
 * helper's capture pipeline: MJPEG frames are always produced; H.264/AVCC runs
 * only while `setAvccActive(true)`. Encoded frames arrive via the `onFrame`
 * callback on the JS thread (marshalled from the native encode thread).
 */
export class NativeCapture {
  private readonly handle: SimCaptureHandle;

  constructor(udid: string, onFrame: (frame: NativeFrame) => void) {
    this.handle = new (load().SimCapture)(udid, (codec, data, width, height, flags) => {
      onFrame({
        codec: codec === CODEC_AVCC ? "avcc" : "mjpeg",
        data,
        width,
        height,
        isDescription: (flags & FLAG_DESCRIPTION) !== 0,
        isKeyframe: (flags & FLAG_KEYFRAME) !== 0,
      });
    });
  }

  /** Begin capturing. Throws if the device isn't booted. */
  start(): void {
    this.handle.start();
  }

  /** Enable/disable H.264 encoding (forces an IDR on the next frame when enabled). */
  setAvccActive(active: boolean): void {
    this.handle.setAvccActive(active);
  }

  /** Force the next H.264 frame to a keyframe (e.g. when a new AVCC viewer joins). */
  requestKeyframe(): void {
    this.handle.requestKeyframe();
  }

  screenSize(): { width: number; height: number } {
    return this.handle.screenSize();
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
