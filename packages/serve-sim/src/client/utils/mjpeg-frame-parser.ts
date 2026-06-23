/**
 * Incremental parser for an MJPEG (`multipart/x-mixed-replace`) byte stream.
 * Feed it chunks via `push`; it emits each complete JPEG frame as a `Uint8Array`
 * view into its internal buffer (copy it if you need to retain it past the call).
 *
 * The helper frames each part as
 *   `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<JPEG>`
 * so we read `N` from the ~70-byte ASCII header and slice exactly that many
 * bytes — the JPEG payload itself is never scanned. A FFD8/FFD9 marker scan
 * remains as a fallback for any helper that omits the Content-Length header.
 *
 * Accumulation matters as much as parsing here: a proxy or port-forward tunnel
 * splits each ~256KB frame into many small chunks, each surfacing as a separate
 * `reader.read()`. The previous implementation rebuilt the whole accumulation
 * buffer on every chunk (`new Uint8Array(buffer.length + value.length)` + two
 * copies), which is O(bytes²) per frame and churns ~1GB/s of throwaway buffers
 * at tunnel chunk sizes — enough GC pressure to freeze the tab. (localhost never
 * tripped it because the loopback coalesces same-time writes into a couple of
 * big chunks per frame.) This version appends into a growable buffer with
 * amortised doubling and an in-place compaction cursor, so appends are amortised
 * O(1) regardless of how finely the stream is chunked.
 */
export interface MjpegFrameParser {
  /** Feed the next chunk of stream bytes; emits any frames it completes. */
  push(value: Uint8Array): void;
}

export function createMjpegFrameParser(
  emit: (jpeg: Uint8Array) => void,
): MjpegFrameParser {
  // `len` is the logical end of valid bytes in `buffer`; `start` is the read
  // cursor of already-consumed bytes.
  let buffer = new Uint8Array(64 * 1024);
  let len = 0;
  let start = 0;
  // Header-scan window: a multipart part header is ~70 bytes. If we don't find
  // the blank-line terminator within this many bytes of `start` we assume
  // header-less framing and fall back to JPEG marker scanning.
  const HEADER_WINDOW = 1024;
  const decoder = new TextDecoder("latin1");

  const append = (value: Uint8Array) => {
    if (len + value.length > buffer.length) {
      // Reclaim the consumed prefix first; only grow if still short.
      if (start > 0) {
        buffer.copyWithin(0, start, len);
        len -= start;
        start = 0;
      }
      if (len + value.length > buffer.length) {
        let cap = buffer.length;
        while (cap < len + value.length) cap *= 2;
        const grown = new Uint8Array(cap);
        grown.set(buffer.subarray(0, len));
        buffer = grown;
      }
    }
    buffer.set(value, len);
    len += value.length;
  };

  // Index of the \r\n\r\n (header terminator) at/after `from`, or -1.
  const findHeaderEnd = (from: number): number => {
    const end = Math.min(len - 4, from + HEADER_WINDOW);
    for (let i = from; i <= end; i++) {
      if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a && buffer[i + 2] === 0x0d && buffer[i + 3] === 0x0a) {
        return i;
      }
    }
    return -1;
  };

  const contentLength = (from: number, to: number): number | null => {
    const header = decoder.decode(buffer.subarray(from, to));
    const m = /content-length:\s*(\d+)/i.exec(header);
    return m ? Number(m[1]) : null;
  };

  // Fallback for header-less streams: extract one JPEG by FFD8..FFD9. The EOI
  // (FFD9) search resumes from `markerScanFrom` rather than rescanning the whole
  // buffered payload on every push — without it, a header-less frame split
  // across many tunnel reads would be O(bytes²) per frame (the same trap the
  // accumulation buffer avoids). Absolute index into `buffer`; shifted on
  // compaction, reset once a frame completes.
  let markerScanFrom = 0;
  const scanJpeg = (from: number): { s: number; e: number } | null => {
    let s = -1;
    for (let i = from; i < len - 1; i++) {
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd8) { s = i; break; }
    }
    if (s === -1) return null;
    for (let i = Math.max(s + 2, markerScanFrom); i < len - 1; i++) {
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) {
        markerScanFrom = 0;
        return { s, e: i + 2 };
      }
    }
    // No EOI yet — resume from the tail (catches an FF/D9 split across reads)
    // instead of rescanning from the SOI next push.
    markerScanFrom = Math.max(s + 2, len - 1);
    return null;
  };

  const drain = () => {
    while (start < len) {
      const headerEnd = findHeaderEnd(start);
      if (headerEnd >= 0) {
        const frameLen = contentLength(start, headerEnd);
        if (frameLen != null && frameLen > 0) {
          const jpegStart = headerEnd + 4;
          const jpegEnd = jpegStart + frameLen;
          if (len < jpegEnd) break; // wait for the rest of the frame
          emit(buffer.subarray(jpegStart, jpegEnd));
          start = jpegEnd;
          continue;
        }
      } else if (len - start <= HEADER_WINDOW) {
        break; // header may simply be incomplete — wait for more bytes
      }
      // No usable header: header-less framing or a malformed part.
      const fr = scanJpeg(start);
      if (!fr) break;
      emit(buffer.subarray(fr.s, fr.e));
      start = fr.e;
    }
    // Compact: drop the consumed prefix so the buffer stays small.
    if (start > 0) {
      if (start < len) buffer.copyWithin(0, start, len);
      len -= start;
      // The marker cursor is an absolute index; shift it with the buffer.
      markerScanFrom = markerScanFrom > start ? markerScanFrom - start : 0;
      start = 0;
    }
  };

  return {
    push(value: Uint8Array) {
      if (value.length === 0) return;
      append(value);
      drain();
    },
  };
}
