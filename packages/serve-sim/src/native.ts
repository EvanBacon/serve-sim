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
  version(): string;
  add(a: number, b: number): number;
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

/** Native addon version banner — also a cheap load smoke-test. */
export function nativeVersion(): string {
  return load().version();
}
