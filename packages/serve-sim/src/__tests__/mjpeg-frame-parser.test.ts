import { describe, expect, test } from "bun:test";
import { createMjpegFrameParser } from "../client/utils/mjpeg-frame-parser";

// Wall-clock perf assertions are sensitive to noisy-neighbour scheduling, GC,
// and thermal throttling on shared CI runners, so they're opt-in via
// RUN_PERF_TESTS. The correctness tests (which also exercise the same heavily
// fragmented paths) run everywhere and are what gate normal CI.
const perfTest = process.env.RUN_PERF_TESTS ? test : test.skip;

// Build a synthetic MJPEG byte stream of `n` frames, each a distinct JPEG
// (FFD8 … FFD9) wrapped in the helper's multipart part header. Returns the
// stream bytes plus the exact frame payloads so tests can assert byte-equality.
function buildStream(n: number, frameSize: number, withHeaders = true) {
  const frames: Uint8Array[] = [];
  const parts: Uint8Array[] = [];
  for (let f = 0; f < n; f++) {
    const jpeg = new Uint8Array(frameSize);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    for (let i = 2; i < frameSize - 2; i++) jpeg[i] = (f * 31 + i) & 0xff;
    jpeg[frameSize - 2] = 0xff;
    jpeg[frameSize - 1] = 0xd9;
    frames.push(jpeg);
    if (withHeaders) {
      parts.push(
        new TextEncoder().encode(
          `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameSize}\r\n\r\n`,
        ),
      );
    }
    parts.push(jpeg);
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const stream = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    stream.set(p, o);
    o += p.length;
  }
  return { stream, frames };
}

// Drive a fresh parser, pushing `stream` in fixed-size pieces. Frame views are
// copied on emit because the parser hands back views into its reused buffer.
function collect(stream: Uint8Array, pieceSize: number): Uint8Array[] {
  const got: Uint8Array[] = [];
  const parser = createMjpegFrameParser((jpeg) => got.push(jpeg.slice()));
  for (let off = 0; off < stream.length; off += pieceSize) {
    parser.push(stream.subarray(off, Math.min(off + pieceSize, stream.length)));
  }
  return got;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("createMjpegFrameParser", () => {
  test("extracts every frame intact regardless of chunk size", () => {
    const { stream, frames } = buildStream(8, 4096);
    // From whole-stream down to pathological 1-byte chunks (a tunnel that
    // splits each frame into thousands of separate reads).
    for (const piece of [stream.length, 65536, 1024, 100, 1]) {
      const got = collect(stream, piece);
      expect(got.length).toBe(frames.length);
      for (let i = 0; i < frames.length; i++) {
        expect(bytesEqual(got[i]!, frames[i]!)).toBe(true);
      }
    }
  });

  test("falls back to FFD8/FFD9 scan for header-less framing", () => {
    const { stream, frames } = buildStream(4, 2048, /* withHeaders */ false);
    const got = collect(stream, 64);
    expect(got.length).toBe(frames.length);
    for (let i = 0; i < frames.length; i++) {
      expect(bytesEqual(got[i]!, frames[i]!)).toBe(true);
    }
  });

  test("header-less: large frames reassemble byte-perfect under fine chunking", () => {
    // Exercises the resumed FFD9 scan cursor — a header-less frame split into
    // 1-byte reads must still extract intact (and not rescan from the SOI each
    // push). 1-byte chunking is the worst case for the EOI search.
    const { stream, frames } = buildStream(3, 32 * 1024, /* withHeaders */ false);
    for (const piece of [1, 7, 64]) {
      const got = collect(stream, piece);
      expect(got.length).toBe(frames.length);
      for (let i = 0; i < frames.length; i++) {
        expect(bytesEqual(got[i]!, frames[i]!)).toBe(true);
      }
    }
  });

  test("emits a frame only once fully buffered", () => {
    const { stream, frames } = buildStream(1, 8192);
    const got: Uint8Array[] = [];
    const parser = createMjpegFrameParser((jpeg) => got.push(jpeg.slice()));
    // Feed everything except the final byte: no complete frame yet.
    parser.push(stream.subarray(0, stream.length - 1));
    expect(got.length).toBe(0);
    parser.push(stream.subarray(stream.length - 1));
    expect(got.length).toBe(1);
    expect(bytesEqual(got[0]!, frames[0]!)).toBe(true);
  });

  // Regression guard for the freeze: the previous parser rebuilt the whole
  // accumulation buffer on every chunk, making per-frame work O(bytes²) in the
  // number of chunks. Splitting a frame into N× more pieces must not blow up
  // the work superlinearly. We compare wall-clock between coarse and fine
  // chunking of the same payload; the amortised-O(1) append keeps the ratio
  // bounded. (O(n²) accumulation pushed this ratio into the hundreds.) Opt-in
  // (RUN_PERF_TESTS) — see `perfTest` note above.
  const nearLinear = (withHeaders: boolean) => () => {
    const { stream } = buildStream(20, 256 * 1024, withHeaders); // native-res frames
    const time = (piece: number) => {
      collect(stream, piece); // warm
      let best = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        collect(stream, piece);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    const coarse = time(64 * 1024); // ~4 pieces / frame (localhost-like)
    const fine = time(512); // ~512 pieces / frame (tunnel-like)
    // Linear accumulation: ~constant. The O(bytes²) regression made `fine`
    // 50–100× `coarse`; a generous 15× ceiling catches it without flaking.
    expect(fine).toBeLessThan(coarse * 15 + 50);
  };
  // Cover both the Content-Length header path and the header-less FFD9-scan
  // path — the latter is where the resumed marker cursor matters.
  perfTest("accumulation cost stays near-linear (header path)", nearLinear(true));
  perfTest("accumulation cost stays near-linear (header-less scan path)", nearLinear(false));
});
