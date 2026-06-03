import { describe, expect, test } from "bun:test";
import {
  AvccDemuxer,
  avcCodecString,
  AVCC_TAG_DESCRIPTION,
  AVCC_TAG_KEYFRAME,
  AVCC_TAG_DELTA,
  AVCC_TAG_SEED,
} from "../avcc-codec";

/** Build one wire chunk: [len:u32-be][tag][payload]. len = payload + 1. */
function frame(tag: number, payload: number[]): Uint8Array {
  const length = payload.length + 1;
  const out = new Uint8Array(4 + length);
  const view = new DataView(out.buffer);
  view.setUint32(0, length, false);
  out[4] = tag;
  out.set(payload, 5);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe("AvccDemuxer", () => {
  test("parses a single complete chunk", () => {
    const d = new AvccDemuxer();
    const chunks = d.push(frame(AVCC_TAG_KEYFRAME, [1, 2, 3, 4]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("keyframe");
    expect(Array.from(chunks[0]!.payload)).toEqual([1, 2, 3, 4]);
  });

  test("parses multiple chunks in one push, preserving order and type", () => {
    const d = new AvccDemuxer();
    const chunks = d.push(
      concat(
        frame(AVCC_TAG_DESCRIPTION, [0x01, 0x64, 0x00, 0x28]),
        frame(AVCC_TAG_KEYFRAME, [9]),
        frame(AVCC_TAG_DELTA, [8, 7]),
        frame(AVCC_TAG_SEED, [0xff, 0xd8, 0xff, 0xd9]),
      ),
    );
    expect(chunks.map((c) => c.type)).toEqual([
      "description",
      "keyframe",
      "delta",
      "seed",
    ]);
  });

  test("buffers a chunk split across reads (header split)", () => {
    const d = new AvccDemuxer();
    const f = frame(AVCC_TAG_DELTA, [10, 11, 12]);
    // Split mid-length-prefix.
    expect(d.push(f.slice(0, 2))).toHaveLength(0);
    const chunks = d.push(f.slice(2));
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0]!.payload)).toEqual([10, 11, 12]);
  });

  test("buffers a chunk split across reads (payload split)", () => {
    const d = new AvccDemuxer();
    const f = frame(AVCC_TAG_KEYFRAME, [1, 2, 3, 4, 5, 6]);
    expect(d.push(f.slice(0, 6))).toHaveLength(0); // header + 1 payload byte
    const chunks = d.push(f.slice(6));
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0]!.payload)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("handles a single byte arriving at a time", () => {
    const d = new AvccDemuxer();
    const f = frame(AVCC_TAG_DELTA, [42, 43]);
    let chunks: ReturnType<AvccDemuxer["push"]> = [];
    for (const b of f) chunks = chunks.concat(d.push(new Uint8Array([b])));
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0]!.payload)).toEqual([42, 43]);
  });

  test("yields partial leading chunk then holds the rest", () => {
    const d = new AvccDemuxer();
    const a = frame(AVCC_TAG_KEYFRAME, [1]);
    const b = frame(AVCC_TAG_DELTA, [2, 3]);
    const combined = concat(a, b);
    // Deliver all of `a` plus only the first 3 bytes of `b`.
    const first = d.push(combined.slice(0, a.length + 3));
    expect(first.map((c) => c.type)).toEqual(["keyframe"]);
    const rest = d.push(combined.slice(a.length + 3));
    expect(rest.map((c) => c.type)).toEqual(["delta"]);
    expect(Array.from(rest[0]!.payload)).toEqual([2, 3]);
  });

  test("skips unknown tags without stalling the stream", () => {
    const d = new AvccDemuxer();
    const chunks = d.push(
      concat(frame(0x7f, [1, 2]), frame(AVCC_TAG_KEYFRAME, [5])),
    );
    expect(chunks.map((c) => c.type)).toEqual(["keyframe"]);
  });

  test("reset() drops buffered partial bytes", () => {
    const d = new AvccDemuxer();
    const f = frame(AVCC_TAG_DELTA, [1, 2, 3]);
    d.push(f.slice(0, 4)); // buffer a partial header
    d.reset();
    // A fresh complete chunk now parses cleanly (no leftover corruption).
    const chunks = d.push(frame(AVCC_TAG_KEYFRAME, [9]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("keyframe");
  });
});

describe("avcCodecString", () => {
  test("derives avc1.<profile><constraints><level> from the avcC blob", () => {
    // avcC layout: [version=1][profile][constraints][level]…
    const blob = new Uint8Array([0x01, 0x64, 0x00, 0x28, 0xff, 0xe1]);
    expect(avcCodecString(blob)).toBe("avc1.640028");
  });

  test("falls back to a baseline codec for a too-short blob", () => {
    expect(avcCodecString(new Uint8Array([0x01]))).toBe("avc1.42E01E");
  });
});
