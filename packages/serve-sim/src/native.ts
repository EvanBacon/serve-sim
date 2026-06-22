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

type Handle = unknown;

interface NativeAddon {
  hidCreate(udid: string): Handle;
  hidTouch(h: Handle, type: TouchType, x: number, y: number, w: number, hh: number, edge: number): void;
  hidMultiTouch(h: Handle, type: TouchType, x1: number, y1: number, x2: number, y2: number, w: number, hh: number): void;
  hidButton(h: Handle, button: string, udid: string): void;
  hidButtonHid(h: Handle, page: number, usage: number, phase: ButtonPhase): void;
  hidKey(h: Handle, type: KeyType, usage: number): void;
  hidScroll(h: Handle, dx: number, dy: number, anchorX: number, anchorY: number, w: number, hh: number): void;
  hidDigitalCrown(h: Handle, delta: number): void;
  hidOrientation(h: Handle, orientation: number): boolean;
  hidMemoryWarning(h: Handle): void;
  hidSoftwareKeyboard(h: Handle): void;
  hidCaDebug(h: Handle, name: string, enabled: boolean): boolean;
  captureCreate(udid: string, onFrame: RawFrameCallback): Handle;
  captureStart(h: Handle): void;
  captureSetAvccActive(h: Handle, active: boolean): void;
  captureRequestKeyframe(h: Handle): void;
  captureScreenSize(h: Handle): { width: number; height: number };
  captureStop(h: Handle): void;
  axDescribeAsync(udid: string): Promise<string>;
  axFrontmostAsync(udid: string): Promise<string>;
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
  private readonly n: NativeAddon;
  private readonly handle: Handle;

  constructor(private readonly udid: string) {
    this.n = load();
    this.handle = this.n.hidCreate(udid);
  }

  touch(type: TouchType, x: number, y: number, w: number, h: number, edge = 0): void {
    this.n.hidTouch(this.handle, type, x, y, w, h, edge);
  }

  multiTouch(type: TouchType, x1: number, y1: number, x2: number, y2: number, w: number, h: number): void {
    this.n.hidMultiTouch(this.handle, type, x1, y1, x2, y2, w, h);
  }

  button(button: string): void {
    this.n.hidButton(this.handle, button, this.udid);
  }

  buttonHid(page: number, usage: number, phase: ButtonPhase = "press"): void {
    this.n.hidButtonHid(this.handle, page, usage, phase);
  }

  key(type: KeyType, usage: number): void {
    this.n.hidKey(this.handle, type, usage);
  }

  /** anchorX/anchorY default to screen center when omitted. */
  scroll(dx: number, dy: number, w: number, h: number, anchorX?: number, anchorY?: number): void {
    this.n.hidScroll(this.handle, dx, dy, anchorX ?? NaN, anchorY ?? NaN, w, h);
  }

  digitalCrown(delta: number): void {
    this.n.hidDigitalCrown(this.handle, delta);
  }

  orientation(orientation: number): boolean {
    return this.n.hidOrientation(this.handle, orientation);
  }

  memoryWarning(): void {
    this.n.hidMemoryWarning(this.handle);
  }

  softwareKeyboard(): void {
    this.n.hidSoftwareKeyboard(this.handle);
  }

  caDebug(name: string, enabled: boolean): boolean {
    return this.n.hidCaDebug(this.handle, name, enabled);
  }
}

/**
 * In-process frame capture + encode for one simulator. Replaces the spawned
 * helper's capture pipeline: MJPEG frames are always produced; H.264/AVCC runs
 * only while `setAvccActive(true)`. Encoded frames arrive via the `onFrame`
 * callback on the JS thread (marshalled from the native encode thread).
 */
export class NativeCapture {
  private readonly n: NativeAddon;
  private readonly handle: Handle;

  constructor(udid: string, onFrame: (frame: NativeFrame) => void) {
    this.n = load();
    this.handle = this.n.captureCreate(udid, (codec, data, width, height, flags) => {
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
    this.n.captureStart(this.handle);
  }

  /** Enable/disable H.264 encoding (forces an IDR on the next frame when enabled). */
  setAvccActive(active: boolean): void {
    this.n.captureSetAvccActive(this.handle, active);
  }

  /** Force the next H.264 frame to a keyframe (e.g. when a new AVCC viewer joins). */
  requestKeyframe(): void {
    this.n.captureRequestKeyframe(this.handle);
  }

  screenSize(): { width: number; height: number } {
    return this.n.captureScreenSize(this.handle);
  }

  /** Halt frame production. Full teardown happens when this object is GC'd. */
  stop(): void {
    this.n.captureStop(this.handle);
  }
}

/**
 * Async accessibility-tree dump for `udid`, as an axe-shaped JSON string (the
 * src/ax.ts normalizer consumes it unchanged). Runs native AX work off the JS
 * event loop. Rejects if the sim's AX service isn't reachable yet.
 */
export function axDescribeAsync(udid: string): Promise<string> {
  return load().axDescribeAsync(udid);
}

/** Async frontmost-app probe — JSON string `{ bundleId, pid }` for the visible app. */
export function axFrontmostAsync(udid: string): Promise<string> {
  return load().axFrontmostAsync(udid);
}
