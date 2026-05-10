import { describe, expect, test } from "bun:test";
import {
  encodeSingleTouch,
  encodeMultiTouch,
  decodeTouchMessage,
  isBinaryTouchMessage,
  TOUCH_PREFIX,
  MULTI_TOUCH_PREFIX,
} from "../touch-codec";
import type { SingleTouchData, MultiTouchData } from "../touch-codec";

describe("touch-codec edge cases", () => {
  // ─── Single touch round-trip for all subtypes ───

  test.each(["begin", "move", "end"] as const)(
    "single touch round-trip for subtype '%s'",
    (subtype) => {
      const data: SingleTouchData = { type: subtype, x: 0.5, y: 0.75 };
      const buf = encodeSingleTouch(data, 42);
      const decoded = decodeTouchMessage(buf);

      expect(decoded).not.toBeNull();
      expect(decoded!.kind).toBe("touch");
      expect(decoded!.data.type).toBe(subtype);
      expect((decoded!.data as SingleTouchData).x).toBeCloseTo(0.5, 5);
      expect((decoded!.data as SingleTouchData).y).toBeCloseTo(0.75, 5);
      expect(decoded!.seq).toBe(42);
    }
  );

  // ─── Multi touch round-trip for all subtypes ───

  test.each(["begin", "move", "end"] as const)(
    "multi touch round-trip for subtype '%s'",
    (subtype) => {
      const data: MultiTouchData = { type: subtype, x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 };
      const buf = encodeMultiTouch(data, 100);
      const decoded = decodeTouchMessage(buf);

      expect(decoded).not.toBeNull();
      expect(decoded!.kind).toBe("multitouch");
      const d = decoded!.data as MultiTouchData;
      expect(d.type).toBe(subtype);
      expect(d.x1).toBeCloseTo(0.1, 5);
      expect(d.y1).toBeCloseTo(0.2, 5);
      expect(d.x2).toBeCloseTo(0.8, 5);
      expect(d.y2).toBeCloseTo(0.9, 5);
      expect(decoded!.seq).toBe(100);
    }
  );

  // ─── Boundary float values ───

  test("single touch with boundary value x=0, y=0", () => {
    const buf = encodeSingleTouch({ type: "begin", x: 0, y: 0 }, 0);
    const decoded = decodeTouchMessage(buf);
    expect(decoded).not.toBeNull();
    expect((decoded!.data as SingleTouchData).x).toBe(0);
    expect((decoded!.data as SingleTouchData).y).toBe(0);
  });

  test("single touch with boundary value x=1, y=1", () => {
    const buf = encodeSingleTouch({ type: "end", x: 1, y: 1 }, 1);
    const decoded = decodeTouchMessage(buf);
    expect(decoded).not.toBeNull();
    expect((decoded!.data as SingleTouchData).x).toBeCloseTo(1, 5);
    expect((decoded!.data as SingleTouchData).y).toBeCloseTo(1, 5);
  });

  test("single touch with NaN coordinates", () => {
    const buf = encodeSingleTouch({ type: "move", x: NaN, y: NaN }, 5);
    const decoded = decodeTouchMessage(buf);
    expect(decoded).not.toBeNull();
    expect((decoded!.data as SingleTouchData).x).toBeNaN();
    expect((decoded!.data as SingleTouchData).y).toBeNaN();
  });

  test("single touch with negative coordinates", () => {
    const buf = encodeSingleTouch({ type: "move", x: -0.1, y: -0.5 }, 10);
    const decoded = decodeTouchMessage(buf);
    expect(decoded).not.toBeNull();
    expect((decoded!.data as SingleTouchData).x).toBeCloseTo(-0.1, 5);
    expect((decoded!.data as SingleTouchData).y).toBeCloseTo(-0.5, 5);
  });

  test("single touch with large float values", () => {
    const buf = encodeSingleTouch({ type: "move", x: 999.99, y: -999.99 }, 1);
    const decoded = decodeTouchMessage(buf);
    expect(decoded).not.toBeNull();
    expect((decoded!.data as SingleTouchData).x).toBeCloseTo(999.99, 1);
    expect((decoded!.data as SingleTouchData).y).toBeCloseTo(-999.99, 1);
  });

  // ─── Sequence number edge cases ───

  test("seq=0 round-trips correctly", () => {
    const buf = encodeSingleTouch({ type: "begin", x: 0.5, y: 0.5 }, 0);
    const decoded = decodeTouchMessage(buf);
    expect(decoded!.seq).toBe(0);
  });

  test("seq=65535 (max u16) round-trips correctly", () => {
    const buf = encodeSingleTouch({ type: "move", x: 0.5, y: 0.5 }, 65535);
    const decoded = decodeTouchMessage(buf);
    expect(decoded!.seq).toBe(65535);
  });

  test("seq=65536 wraps to 0 (u16 overflow)", () => {
    // DataView.setUint16 truncates to 16 bits
    const buf = encodeSingleTouch({ type: "move", x: 0.5, y: 0.5 }, 65536);
    const decoded = decodeTouchMessage(buf);
    expect(decoded!.seq).toBe(0);
  });

  test("seq=65537 wraps to 1 (u16 overflow)", () => {
    const buf = encodeSingleTouch({ type: "move", x: 0.5, y: 0.5 }, 65537);
    const decoded = decodeTouchMessage(buf);
    expect(decoded!.seq).toBe(1);
  });

  // ─── Edge byte ───

  test("single touch with edge byte included", () => {
    const buf = encodeSingleTouch({ type: "move", x: 0.5, y: 0.5, edge: 3 }, 10);
    expect(new Uint8Array(buf).byteLength).toBe(13);
    const decoded = decodeTouchMessage(buf);
    expect(decoded).not.toBeNull();
    expect(decoded!.kind).toBe("touch");
    expect((decoded!.data as SingleTouchData).edge).toBe(3);
  });

  test("single touch without edge byte", () => {
    const buf = encodeSingleTouch({ type: "move", x: 0.5, y: 0.5 }, 10);
    expect(new Uint8Array(buf).byteLength).toBe(12);
    const decoded = decodeTouchMessage(buf);
    expect(decoded).not.toBeNull();
    expect((decoded!.data as SingleTouchData).edge).toBeUndefined();
  });

  test("edge byte 0 is preserved (not treated as absent)", () => {
    const buf = encodeSingleTouch({ type: "move", x: 0.5, y: 0.5, edge: 0 }, 10);
    expect(new Uint8Array(buf).byteLength).toBe(13);
    const decoded = decodeTouchMessage(buf);
    expect((decoded!.data as SingleTouchData).edge).toBe(0);
  });

  test("edge byte 255 (max u8)", () => {
    const buf = encodeSingleTouch({ type: "begin", x: 0.1, y: 0.9, edge: 255 }, 1);
    const decoded = decodeTouchMessage(buf);
    expect((decoded!.data as SingleTouchData).edge).toBe(255);
  });

  // ─── Decode error cases ───

  test("returns null for buffer shorter than 12 bytes", () => {
    const buf = new ArrayBuffer(8);
    expect(decodeTouchMessage(buf)).toBeNull();
  });

  test("returns null for unknown prefix", () => {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    view.setUint8(0, 0xFF);
    expect(decodeTouchMessage(buf)).toBeNull();
  });

  test("returns null for invalid subtype index (>2)", () => {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    view.setUint8(0, TOUCH_PREFIX);
    view.setUint8(1, 3); // invalid subtype
    expect(decodeTouchMessage(buf)).toBeNull();
  });

  test("returns null for multi-touch buffer shorter than 20 bytes", () => {
    const buf = new ArrayBuffer(15);
    const view = new DataView(buf);
    view.setUint8(0, MULTI_TOUCH_PREFIX);
    view.setUint8(1, 0);
    expect(decodeTouchMessage(buf)).toBeNull();
  });

  test("returns null for multi-touch with invalid subtype", () => {
    const buf = new ArrayBuffer(20);
    const view = new DataView(buf);
    view.setUint8(0, MULTI_TOUCH_PREFIX);
    view.setUint8(1, 5); // invalid
    expect(decodeTouchMessage(buf)).toBeNull();
  });

  // ─── Uint8Array input ───

  test("decodeTouchMessage accepts Uint8Array", () => {
    const buf = encodeSingleTouch({ type: "begin", x: 0.3, y: 0.7 }, 99);
    const u8 = new Uint8Array(buf);
    const decoded = decodeTouchMessage(u8);
    expect(decoded).not.toBeNull();
    expect((decoded!.data as SingleTouchData).x).toBeCloseTo(0.3, 5);
    expect(decoded!.seq).toBe(99);
  });

  test("decodeTouchMessage handles Uint8Array with offset", () => {
    // Simulate a subarray scenario
    const innerBuf = encodeSingleTouch({ type: "end", x: 0.9, y: 0.1 }, 7);
    const padded = new Uint8Array(4 + innerBuf.byteLength);
    padded.set(new Uint8Array(innerBuf), 4);
    const slice = padded.subarray(4);
    const decoded = decodeTouchMessage(slice);
    expect(decoded).not.toBeNull();
    expect(decoded!.data.type).toBe("end");
    expect(decoded!.seq).toBe(7);
  });

  // ─── isBinaryTouchMessage ───

  test("isBinaryTouchMessage returns true for single touch prefix", () => {
    const buf = new Uint8Array([TOUCH_PREFIX, 0, 0, 0]);
    expect(isBinaryTouchMessage(buf)).toBe(true);
  });

  test("isBinaryTouchMessage returns true for multi-touch prefix", () => {
    const buf = new Uint8Array([MULTI_TOUCH_PREFIX, 0, 0, 0]);
    expect(isBinaryTouchMessage(buf)).toBe(true);
  });

  test("isBinaryTouchMessage returns false for unknown prefix", () => {
    const buf = new Uint8Array([0x01, 0, 0, 0]);
    expect(isBinaryTouchMessage(buf)).toBe(false);
  });

  test("isBinaryTouchMessage returns false for empty buffer", () => {
    const buf = new Uint8Array(0);
    expect(isBinaryTouchMessage(buf)).toBe(false);
  });

  test("isBinaryTouchMessage accepts ArrayBuffer", () => {
    const buf = encodeSingleTouch({ type: "begin", x: 0, y: 0 }, 0);
    expect(isBinaryTouchMessage(buf)).toBe(true);
  });
});
