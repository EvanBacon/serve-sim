import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inflateSync } from "zlib";
import { diffFrames, encodePng, renderDiffImage, type RgbaFrame } from "../frame-image";

function solid(width: number, height: number, [r, g, b]: [number, number, number]): RgbaFrame {
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) rgba.set([r, g, b, 255], p * 4);
  return { width, height, rgba };
}

function paint(frame: RgbaFrame, x0: number, y0: number, w: number, h: number, color: [number, number, number]) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) frame.rgba.set([...color, 255], (y * frame.width + x) * 4);
}

/** Minimal PNG reader for the encoder's own output (8-bit RGB, filter 0). */
function decodePng(png: Uint8Array): { width: number; height: number; rgb: Uint8Array; chunks: string[] } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  const chunks: string[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    chunks.push(type);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      expect([...data.subarray(8, 13)]).toEqual([8, 2, 0, 0, 0]);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 3 + 1)]).toBe(0);
    rgb.set(raw.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1)), y * width * 3);
  }
  return { width, height, rgb, chunks };
}

describe("encodePng", () => {
  test("round-trips pixels as 8-bit RGB", () => {
    const frame = solid(5, 3, [10, 20, 30]);
    paint(frame, 1, 1, 2, 1, [200, 100, 0]);
    const png = encodePng(frame);
    const decoded = decodePng(png);
    expect(decoded.chunks).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(decoded.width).toBe(5);
    expect(decoded.height).toBe(3);
    expect([...decoded.rgb.subarray(0, 3)]).toEqual([10, 20, 30]);
    expect([...decoded.rgb.subarray((1 * 5 + 1) * 3, (1 * 5 + 1) * 3 + 3)]).toEqual([200, 100, 0]);
  });

  test("rejects a buffer that doesn't match the size", () => {
    expect(() => encodePng({ width: 2, height: 2, rgba: new Uint8Array(3) })).toThrow(/expected 16 bytes/);
  });

  test.skipIf(process.platform !== "darwin")("is a PNG ImageIO accepts (sips)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "png-")), "x.png");
    writeFileSync(path, encodePng(solid(7, 4, [1, 2, 3])));
    const out = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", path], { encoding: "utf8" });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("pixelWidth: 7");
    expect(out.stdout).toContain("pixelHeight: 4");
    expect(out.stdout).toContain("format: png");
  });
});

describe("diffFrames", () => {
  test("identical frames: 0 changed pixels, null bbox", () => {
    const a = solid(8, 6, [50, 60, 70]);
    const result = diffFrames(a, solid(8, 6, [50, 60, 70]));
    expect(result.changedPixels).toBe(0);
    expect(result.bbox).toBeNull();
  });

  test("a changed rectangle gives its bbox and pixel count", () => {
    const a = solid(10, 8, [0, 0, 0]);
    const b = solid(10, 8, [0, 0, 0]);
    paint(b, 2, 3, 4, 2, [255, 255, 255]);
    const result = diffFrames(a, b);
    expect(result.changedPixels).toBe(8);
    expect(result.bbox).toEqual({ x: 2, y: 3, w: 4, h: 2 });
  });

  test("differences at or below the threshold are ignored (codec noise)", () => {
    const a = solid(4, 4, [100, 100, 100]);
    const b = solid(4, 4, [100, 100, 100]);
    paint(b, 0, 0, 1, 1, [110, 100, 100]); // Δ10
    paint(b, 3, 3, 1, 1, [100, 160, 100]); // Δ60
    expect(diffFrames(a, b, { threshold: 10 }).changedPixels).toBe(1);
    expect(diffFrames(a, b, { threshold: 10 }).bbox).toEqual({ x: 3, y: 3, w: 1, h: 1 });
    expect(diffFrames(a, b, { threshold: 9 }).changedPixels).toBe(2);
    expect(diffFrames(a, b, { threshold: 60 }).changedPixels).toBe(0);
  });

  test("mismatched sizes are an error", () => {
    expect(() => diffFrames(solid(4, 4, [0, 0, 0]), solid(4, 5, [0, 0, 0]))).toThrow(/4x4 vs 4x5/);
  });
});

describe("renderDiffImage", () => {
  test("changed pixels are highlighted, unchanged ones dimmed, bbox outlined", () => {
    const a = solid(20, 20, [200, 200, 200]);
    const b = solid(20, 20, [200, 200, 200]);
    paint(b, 8, 8, 4, 4, [0, 0, 255]);
    const diff = diffFrames(a, b);
    const image = renderDiffImage(b, diff);
    const px = (x: number, y: number) => [...image.rgba.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)];
    // Inside the change: the highlight color.
    expect(px(9, 9)).toEqual([255, 0, 255, 255]);
    // Far from it: the "after" pixel, dimmed (darker but not black).
    const [r, g, bl] = px(0, 0);
    expect(r!).toBeLessThan(200);
    expect(r!).toBeGreaterThan(40);
    expect(r).toBe(g!);
    expect(g).toBe(bl!);
    // The bbox outline sits just outside the change.
    expect(px(7, 10)).toEqual([255, 214, 0, 255]);
    expect(px(10, 12)).toEqual([255, 214, 0, 255]);
    // Same size as the input; input untouched.
    expect(image.width).toBe(20);
    expect([...b.rgba.subarray(0, 4)]).toEqual([200, 200, 200, 255]);
  });

  test("no change: just the dimmed frame", () => {
    const a = solid(4, 4, [200, 200, 200]);
    const image = renderDiffImage(a, diffFrames(a, a));
    expect(new Set([...image.rgba].filter((_, k) => k % 4 === 0)).size).toBe(1);
  });
});
