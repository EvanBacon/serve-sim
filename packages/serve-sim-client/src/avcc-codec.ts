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
  private buffer = new Uint8Array(0);

  push(bytes: Uint8Array): AvccChunk[] {
    if (bytes.length > 0) {
      const merged = new Uint8Array(this.buffer.length + bytes.length);
      merged.set(this.buffer);
      merged.set(bytes, this.buffer.length);
      this.buffer = merged;
    }

    const chunks: AvccChunk[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4);
      const length = view.getUint32(0, false);
      // length covers the tag byte + payload; need that many bytes after the
      // 4-byte header before the chunk is complete.
      if (this.buffer.length - offset - 4 < length) break;
      if (length < 1) {
        // Malformed (length must include the tag byte). Skip the header and
        // resync rather than spinning forever.
        offset += 4;
        continue;
      }
      const tag = this.buffer[offset + 4]!;
      const payload = this.buffer.slice(offset + 5, offset + 4 + length);
      const type = TAG_TO_TYPE[tag];
      if (type) chunks.push({ type, payload });
      offset += 4 + length;
    }

    this.buffer = offset === 0 ? this.buffer : this.buffer.slice(offset);
    return chunks;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
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
