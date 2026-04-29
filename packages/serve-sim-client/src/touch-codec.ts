/**
 * Binary codec for touch messages sent over WebSocket.
 *
 * Single touch (prefix 0x10):
 *   [0x10] [subtype:u8] [x:f32] [y:f32] [seq:u16] [edge:u8]
 *   Total: 12 bytes, or 13 with edge
 *
 * Multi-touch (prefix 0x11):
 *   [0x11] [subtype:u8] [x1:f32] [y1:f32] [x2:f32] [y2:f32] [seq:u16]
 *   Total: 20 bytes
 */

export const TOUCH_PREFIX = 0x10;
export const MULTI_TOUCH_PREFIX = 0x11;

const SUBTYPE_MAP = { begin: 0, move: 1, end: 2 } as const;
const SUBTYPE_REVERSE = ["begin", "move", "end"] as const;

export interface SingleTouchData {
  type: "begin" | "move" | "end";
  x: number;
  y: number;
  edge?: number;
}

export interface MultiTouchData {
  type: "begin" | "move" | "end";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Encode a single-touch message into an ArrayBuffer. */
export function encodeSingleTouch(data: SingleTouchData, seq: number): ArrayBuffer {
  const hasEdge = data.edge !== undefined;
  const size = hasEdge ? 13 : 12;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  view.setUint8(0, TOUCH_PREFIX);
  view.setUint8(1, SUBTYPE_MAP[data.type]);
  view.setFloat32(2, data.x);
  view.setFloat32(6, data.y);
  view.setUint16(10, seq);
  if (hasEdge) {
    view.setUint8(12, data.edge!);
  }
  return buf;
}

/** Encode a multi-touch message into an ArrayBuffer. */
export function encodeMultiTouch(data: MultiTouchData, seq: number): ArrayBuffer {
  const buf = new ArrayBuffer(20);
  const view = new DataView(buf);
  view.setUint8(0, MULTI_TOUCH_PREFIX);
  view.setUint8(1, SUBTYPE_MAP[data.type]);
  view.setFloat32(2, data.x1);
  view.setFloat32(6, data.y1);
  view.setFloat32(10, data.x2);
  view.setFloat32(14, data.y2);
  view.setUint16(18, seq);
  return buf;
}

export interface DecodedSingleTouch {
  kind: "touch";
  data: SingleTouchData;
  seq: number;
}

export interface DecodedMultiTouch {
  kind: "multitouch";
  data: MultiTouchData;
  seq: number;
}

/** Decode a binary touch message. Returns null if prefix is unknown. */
export function decodeTouchMessage(
  buf: ArrayBuffer | Uint8Array
): DecodedSingleTouch | DecodedMultiTouch | null {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 12) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prefix = view.getUint8(0);

  if (prefix === TOUCH_PREFIX) {
    const subtypeIdx = view.getUint8(1);
    if (subtypeIdx > 2) return null;
    const x = view.getFloat32(2);
    const y = view.getFloat32(6);
    const seq = view.getUint16(10);
    const data: SingleTouchData = {
      type: SUBTYPE_REVERSE[subtypeIdx],
      x,
      y,
    };
    if (bytes.length >= 13) {
      data.edge = view.getUint8(12);
    }
    return { kind: "touch", data, seq };
  }

  if (prefix === MULTI_TOUCH_PREFIX) {
    if (bytes.length < 20) return null;
    const subtypeIdx = view.getUint8(1);
    if (subtypeIdx > 2) return null;
    const x1 = view.getFloat32(2);
    const y1 = view.getFloat32(6);
    const x2 = view.getFloat32(10);
    const y2 = view.getFloat32(14);
    const seq = view.getUint16(18);
    return {
      kind: "multitouch",
      data: { type: SUBTYPE_REVERSE[subtypeIdx], x1, y1, x2, y2 },
      seq,
    };
  }

  return null;
}

/**
 * Check if a binary message is a touch message (starts with 0x10 or 0x11).
 */
export function isBinaryTouchMessage(buf: ArrayBuffer | Uint8Array): boolean {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 1) return false;
  return bytes[0] === TOUCH_PREFIX || bytes[0] === MULTI_TOUCH_PREFIX;
}
