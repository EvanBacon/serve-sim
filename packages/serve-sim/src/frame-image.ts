/**
 * Pixel helpers for `serve-sim record frame|diff`: a dependency-free PNG
 * encoder and an RGBA frame diff with a highlight image. Pure (no I/O).
 */
import { deflateSync } from "zlib";

/** Tightly packed 8-bit RGBA, row-major from the top-left. */
export type RgbaFrame = { width: number; height: number; rgba: Uint8Array };

type PixelBox = { x: number; y: number; w: number; h: number };

export type FrameDiff = {
  width: number;
  height: number;
  /** Pixels whose largest channel difference exceeds the threshold. */
  changedPixels: number;
  /** Smallest box holding every changed pixel; null when none changed. */
  bbox: PixelBox | null;
  /** Largest per-channel difference over all pixels (0 for identical frames). */
  maxDelta: number;
  /** 1 per changed pixel (row-major), for rendering. */
  mask: Uint8Array;
};

/**
 * Largest per-channel difference that still counts as unchanged. H.264
 * re-encodes static pixels with small errors: up to ~33 between identical
 * screens in a 60 fps `serve-sim record` capture of iOS Settings, while UI
 * changes (taps, navigation, the home indicator) differ by far more.
 */
export const DEFAULT_DIFF_THRESHOLD = 40;

const HIGHLIGHT = [255, 0, 255] as const;
const OUTLINE = [255, 214, 0] as const;

function checkSize(frame: RgbaFrame): void {
  const expected = frame.width * frame.height * 4;
  if (frame.rgba.length !== expected) {
    throw new Error(`frame is ${frame.width}x${frame.height}: expected ${expected} bytes of RGBA, got ${frame.rgba.length}`);
  }
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  for (let k = 0; k < bytes.length; k++) crc = crcTable[(crc ^ bytes[k]!) & 0xff]! ^ (crc >>> 8);
  return crc;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
  out.set(data, 8);
  view.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

/** Encode an RGBA frame as an 8-bit RGB PNG (video frames are opaque). */
export function encodePng(frame: RgbaFrame): Uint8Array {
  checkSize(frame);
  const { width, height, rgba } = frame;
  const stride = width * 3 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    let o = y * stride + 1; // filter byte 0 (None)
    let p = y * width * 4;
    for (let x = 0; x < width; x++, p += 4) {
      raw[o++] = rgba[p]!;
      raw[o++] = rgba[p + 1]!;
      raw[o++] = rgba[p + 2]!;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolor, deflate, no filter set, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Per-pixel diff of two same-sized frames (max channel |Δ| > threshold). */
export function diffFrames(before: RgbaFrame, after: RgbaFrame, { threshold = DEFAULT_DIFF_THRESHOLD } = {}): FrameDiff {
  checkSize(before);
  checkSize(after);
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`frames differ in size: ${before.width}x${before.height} vs ${after.width}x${after.height}`);
  }
  const { width, height } = after;
  const a = before.rgba;
  const b = after.rgba;
  const mask = new Uint8Array(width * height);
  let changedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let maxDelta = 0;
  for (let y = 0, p = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p++) {
      const o = p * 4;
      const delta = Math.max(Math.abs(a[o]! - b[o]!), Math.abs(a[o + 1]! - b[o + 1]!), Math.abs(a[o + 2]! - b[o + 2]!));
      if (delta > maxDelta) maxDelta = delta;
      if (delta <= threshold) continue;
      mask[p] = 1;
      changedPixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const bbox = changedPixels > 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  return { width, height, changedPixels, bbox, maxDelta, mask };
}

/**
 * The "after" frame in dimmed grayscale with changed pixels painted magenta
 * and the bounding box outlined in amber just outside the change.
 */
export function renderDiffImage(after: RgbaFrame, diff: FrameDiff): RgbaFrame {
  checkSize(after);
  const { width, height } = after;
  const src = after.rgba;
  const rgba = new Uint8Array(src.length);
  for (let p = 0; p < width * height; p++) {
    const o = p * 4;
    if (diff.mask[p]) {
      rgba[o] = HIGHLIGHT[0];
      rgba[o + 1] = HIGHLIGHT[1];
      rgba[o + 2] = HIGHLIGHT[2];
    } else {
      const luma = 0.2126 * src[o]! + 0.7152 * src[o + 1]! + 0.0722 * src[o + 2]!;
      const dim = Math.round(40 + luma * 0.4);
      rgba[o] = dim;
      rgba[o + 1] = dim;
      rgba[o + 2] = dim;
    }
    rgba[o + 3] = 255;
  }
  if (diff.bbox) {
    const t = Math.max(2, Math.round(Math.min(width, height) / 150));
    const { x, y, w, h } = diff.bbox;
    const left = x - t;
    const top = y - t;
    const right = x + w - 1 + t;
    const bottom = y + h - 1 + t;
    const plot = (px: number, py: number) => {
      if (px < 0 || py < 0 || px >= width || py >= height) return;
      const o = (py * width + px) * 4;
      rgba[o] = OUTLINE[0];
      rgba[o + 1] = OUTLINE[1];
      rgba[o + 2] = OUTLINE[2];
    };
    for (let py = top; py <= bottom; py++) {
      for (let px = left; px <= right; px++) {
        const onEdge = px < x || px > x + w - 1 || py < y || py > y + h - 1;
        if (onEdge) plot(px, py);
      }
    }
  }
  return { width, height, rgba };
}
