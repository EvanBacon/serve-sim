import { describe, expect, test } from "bun:test";
import { extractImageFrame } from "../simulator/streamFrames";

const jpeg = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

describe("extractImageFrame", () => {
  test("extracts a JPEG frame from a multipart byte stream", () => {
    const input = concat(ascii("--frame\r\nContent-Type: image/jpeg\r\n\r\n"), jpeg, ascii("\r\nnext"));
    const extracted = extractImageFrame(input);

    expect(extracted?.mimeType).toBe("image/jpeg");
    expect([...extracted!.frame]).toEqual([...jpeg]);
    expect(new TextDecoder().decode(extracted!.rest)).toBe("\r\nnext");
  });

  test("extracts a PNG frame from an Android screencap multipart stream", () => {
    const input = concat(ascii("--frame\r\nContent-Type: image/png\r\n\r\n"), png, ascii("\r\n"));
    const extracted = extractImageFrame(input);

    expect(extracted?.mimeType).toBe("image/png");
    expect([...extracted!.frame]).toEqual([...png]);
    expect(new TextDecoder().decode(extracted!.rest)).toBe("\r\n");
  });

  test("waits for a complete PNG before returning a frame", () => {
    expect(extractImageFrame(png.slice(0, png.length - 2))).toBeNull();
  });

  test("does not emit a false JPEG from inside an incomplete PNG", () => {
    const incompletePngWithJpegMarkers = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x04,
      0x49, 0x44, 0x41, 0x54,
      0xff, 0xd8, 0x00, 0xff, 0xd9,
      0x00, 0x00, 0x00, 0x00,
    ]);

    expect(extractImageFrame(incompletePngWithJpegMarkers)).toBeNull();
  });
});

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
