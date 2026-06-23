import { describe, expect, test } from "bun:test";
import {
  AvccDemuxer,
  avcCodecString,
  AVCC_TAG_DESCRIPTION,
  AVCC_TAG_KEYFRAME,
  AVCC_TAG_DELTA,
  AVCC_TAG_SEED,
} from "../client/avcc-codec.js";

// Wall-clock perf assertion — opt-in via RUN_PERF_TESTS so noisy CI runners
// can't flake it. The fragmentation *correctness* tests run everywhere.
const perfTest = process.env.RUN_PERF_TESTS ? test : test.skip;

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

  test("reassembles a large keyframe delivered in tiny pieces", () => {
    // An IDR fragments into many small tunnel reads — the case that froze the
    // tab under the old per-chunk full-buffer rebuild.
    const payload = Array.from({ length: 120_000 }, (_, i) => i & 0xff);
    const f = frame(AVCC_TAG_KEYFRAME, payload);
    const d = new AvccDemuxer();
    let chunks: ReturnType<AvccDemuxer["push"]> = [];
    for (let off = 0; off < f.length; off += 64) {
      chunks = chunks.concat(d.push(f.subarray(off, Math.min(off + 64, f.length))));
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("keyframe");
    expect(chunks[0]!.payload.length).toBe(payload.length);
    expect(Array.from(chunks[0]!.payload.subarray(0, 4))).toEqual([0, 1, 2, 3]);
  });

  // Regression guard for the tunnel freeze: accumulation must stay near-linear
  // as the same payload is split into finer pieces. The old demuxer rebuilt the
  // whole buffer per push (O(bytes²) per frame), so fine chunking blew up
  // wall-clock by 50–100×; the growable buffer keeps it bounded.
  perfTest("accumulation cost stays near-linear as chunking gets finer", () => {
    // 30 frames of ~64KB each — a stream of IDR-sized chunks.
    const stream = concat(
      ...Array.from({ length: 30 }, (_, f) =>
        frame(AVCC_TAG_KEYFRAME, Array.from({ length: 64 * 1024 }, (_, i) => (f + i) & 0xff)),
      ),
    );
    const run = (piece: number) => {
      const d = new AvccDemuxer();
      let n = 0;
      for (let off = 0; off < stream.length; off += piece) {
        n += d.push(stream.subarray(off, Math.min(off + piece, stream.length))).length;
      }
      return n;
    };
    const time = (piece: number) => {
      run(piece); // warm
      let best = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        run(piece);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    const coarse = time(64 * 1024); // ~1 piece / frame (localhost-like)
    const fine = time(256); // ~256 pieces / frame (tunnel-like)
    expect(fine).toBeLessThan(coarse * 15 + 50);
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
