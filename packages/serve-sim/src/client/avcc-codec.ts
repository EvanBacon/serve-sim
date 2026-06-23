/**
 * Wire parser for the serve-sim `/stream.avcc` H.264 stream.
 *
 * Each chunk is a 4-byte big-endian length (covering the tag byte + payload)
 * followed by a one-byte tag and the payload:
 *
 *   [len:u32-be][tag:u8][payload…]   where len === payload.length + 1
 *
 * Tags (kept in sync with the Swift `AVCCEnvelope`):
 *   0x01 description — avcC parameter-set blob (SPS/PPS); configures decoder
 *   0x02 keyframe    — IDR (decodable standalone)
 *   0x03 delta       — non-IDR P-frame
 *   0x04 seed        — JPEG painted before the first IDR decodes
 *
 * The stream is read incrementally from a `fetch()` ReadableStream, so chunks
 * arrive split across reads. `AvccDemuxer` buffers partial bytes and yields
 * whole chunks. Pure: no DOM, no WebCodecs, no network — unit-testable.
 */

export const AVCC_TAG_DESCRIPTION = 0x01;
export const AVCC_TAG_KEYFRAME = 0x02;
export const AVCC_TAG_DELTA = 0x03;
export const AVCC_TAG_SEED = 0x04;

export type AvccChunkType = "description" | "keyframe" | "delta" | "seed";

export interface AvccChunk {
  type: AvccChunkType;
  /** Payload bytes (tag stripped). */
  payload: Uint8Array;
}

const TAG_TO_TYPE: Record<number, AvccChunkType | undefined> = {
  [AVCC_TAG_DESCRIPTION]: "description",
  [AVCC_TAG_KEYFRAME]: "keyframe",
  [AVCC_TAG_DELTA]: "delta",
  [AVCC_TAG_SEED]: "seed",
};

/**
 * Stateful demuxer that turns a byte stream into whole AVCC chunks. Feed it
 * each `Uint8Array` from the reader; it returns the chunks now fully buffered
 * and retains any trailing partial bytes for the next call.
 */
export class AvccDemuxer {
  // Growable accumulation buffer. `len` is the logical end of valid bytes;
  // `start` is the read cursor of already-consumed bytes. Appending in place
  // (amortised doubling) instead of rebuilding the whole buffer per chunk keeps
  // this O(bytes) overall rather than O(bytes²): a port-forward tunnel splits
  // each frame — keyframes especially — into many small, separately-delivered
  // reads, and the old per-chunk `new Uint8Array(...)` + double copy churned
  // enough throwaway buffers to freeze the tab. See the matching note in
  // `utils/mjpeg-frame-parser.ts`.
  private buffer = new Uint8Array(64 * 1024);
  private len = 0;
  private start = 0;

  private append(bytes: Uint8Array): void {
    if (this.len + bytes.length > this.buffer.length) {
      // Reclaim the consumed prefix first; only grow if still short.
      if (this.start > 0) {
        this.buffer.copyWithin(0, this.start, this.len);
        this.len -= this.start;
        this.start = 0;
      }
      if (this.len + bytes.length > this.buffer.length) {
        let cap = this.buffer.length;
        while (cap < this.len + bytes.length) cap *= 2;
        const grown = new Uint8Array(cap);
        grown.set(this.buffer.subarray(0, this.len));
        this.buffer = grown;
      }
    }
    this.buffer.set(bytes, this.len);
    this.len += bytes.length;
  }

  push(bytes: Uint8Array): AvccChunk[] {
    if (bytes.length > 0) this.append(bytes);

    const chunks: AvccChunk[] = [];
    const buf = this.buffer;
    while (this.len - this.start >= 4) {
      const o = this.start;
      // Big-endian u32; `>>> 0` keeps it unsigned (bit 31 would otherwise sign).
      const length = ((buf[o]! << 24) | (buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!) >>> 0;
      // length covers the tag byte + payload; need that many bytes after the
      // 4-byte header before the chunk is complete.
      if (this.len - o - 4 < length) break;
      if (length < 1) {
        // Malformed (length must include the tag byte). Skip the header and
        // resync rather than spinning forever.
        this.start += 4;
        continue;
      }
      const tag = buf[o + 4]!;
      const type = TAG_TO_TYPE[tag];
      // Copy the payload out: the backing buffer is reused/compacted in place.
      if (type) chunks.push({ type, payload: buf.slice(o + 5, o + 4 + length) });
      this.start += 4 + length;
    }

    // Compact the consumed prefix so the buffer only holds the unparsed tail.
    if (this.start > 0) {
      if (this.start < this.len) this.buffer.copyWithin(0, this.start, this.len);
      this.len -= this.start;
      this.start = 0;
    }
    return chunks;
  }

  reset(): void {
    // Keep the allocated capacity; just drop any buffered bytes.
    this.len = 0;
    this.start = 0;
  }
}

/**
 * Build the WebCodecs `VideoDecoder` codec string from an avcC description
 * blob. The 2nd–4th bytes are profile_idc / constraint flags / level_idc,
 * yielding e.g. `avc1.640028`.
 */
export function avcCodecString(description: Uint8Array): string {
  if (description.length < 4) return "avc1.42E01E";
  const hex2 = (b: number) => b.toString(16).padStart(2, "0");
  return "avc1." + hex2(description[1]!) + hex2(description[2]!) + hex2(description[3]!);
}

/** True when the runtime can decode the AVCC stream (WebCodecs available). */
export function isAvccSupported(): boolean {
  return typeof globalThis !== "undefined" && typeof (globalThis as any).VideoDecoder !== "undefined";
}
