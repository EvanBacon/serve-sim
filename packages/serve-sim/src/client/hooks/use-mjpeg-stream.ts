import { useCallback, useEffect, useRef } from "react";

/**
 * Fetches an MJPEG stream and parses out individual JPEG frames as blob URLs.
 * Chrome doesn't support multipart/x-mixed-replace in <img> tags,
 * so we manually read the stream and extract JPEG boundaries.
 *
 * Screen config (dimensions / orientation) is no longer polled here — it
 * arrives over the input WebSocket — so this hook only deals with frame bytes.
 *
 * The helper frames each part as
 *   `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<JPEG>`
 * so we slice exactly `N` bytes off the wire. The old code scanned every JPEG
 * byte for FFD8/FFD9 markers and reallocated the whole accumulation buffer per
 * chunk — both O(bytes-per-frame) on the main thread, which melts down on weak
 * browsers (the ones without WebCodecs that fall back to MJPEG) under the high
 * frame bitrate of heavy interaction. Reading Content-Length only touches the
 * ~70-byte ASCII header; the JPEG payload is never scanned. A FFD8/FFD9 marker
 * scan remains as a fallback for any helper that omits the headers.
 */
export function useMjpegStream(streamUrl: string | null) {
  const subscribersRef = useRef<Set<(blobUrl: string) => void>>(new Set());

  const subscribeFrame = useCallback(
    (cb: (blobUrl: string) => void) => {
      subscribersRef.current.add(cb);
      return () => { subscribersRef.current.delete(cb); };
    },
    [],
  );

  useEffect(() => {
    if (!streamUrl) return;
    const controller = new AbortController();
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // Read the MJPEG stream and extract JPEG frames.
    // ?raw=1 tells the server to use Content-Type application/octet-stream
    // instead of multipart/x-mixed-replace; WebKit refuses to expose
    // multipart bodies to fetch()'s ReadableStream.
    const fetchUrlObj = new URL(streamUrl);
    fetchUrlObj.searchParams.set("raw", "1");
    const fetchUrl = fetchUrlObj.toString();
    const scheduleRetry = () => {
      if (stopped || controller.signal.aborted || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void readStream();
      }, 1000);
    };

    const emit = (jpeg: Uint8Array) => {
      if (subscribersRef.current.size === 0) return;
      // Blob copies the bytes, so handing it a subarray view is safe even as
      // the underlying accumulation buffer is reused/compacted.
      const blobUrl = URL.createObjectURL(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
      for (const cb of subscribersRef.current) cb(blobUrl);
    };

    const readStream = async () => {
      try {
        const res = await fetch(fetchUrl, { signal: controller.signal });
        const reader = res.body?.getReader();
        if (!reader) {
          scheduleRetry();
          return;
        }

        let buffer = new Uint8Array(0);
        // Cursor of consumed bytes inside `buffer`; we compact the prefix off
        // after each read so the buffer only ever holds the unparsed tail.
        let start = 0;
        // Header-scan window: a multipart part header is ~70 bytes. If we don't
        // find the blank-line terminator within this many bytes of `start` we
        // assume header-less framing and fall back to JPEG marker scanning.
        const HEADER_WINDOW = 1024;

        // Index of the \r\n\r\n (header terminator) at/after `from`, or -1.
        const findHeaderEnd = (buf: Uint8Array, from: number): number => {
          const end = Math.min(buf.length - 4, from + HEADER_WINDOW);
          for (let i = from; i <= end; i++) {
            if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
              return i;
            }
          }
          return -1;
        };

        const decoder = new TextDecoder("latin1");
        const contentLength = (buf: Uint8Array, from: number, to: number): number | null => {
          const header = decoder.decode(buf.subarray(from, to));
          const m = /content-length:\s*(\d+)/i.exec(header);
          return m ? Number(m[1]) : null;
        };

        // Fallback for header-less streams: extract one JPEG by FFD8..FFD9.
        const scanJpeg = (buf: Uint8Array, from: number): { s: number; e: number } | null => {
          let s = -1;
          for (let i = from; i < buf.length - 1; i++) {
            if (buf[i] === 0xff && buf[i + 1] === 0xd8) { s = i; break; }
          }
          if (s === -1) return null;
          for (let i = s + 2; i < buf.length - 1; i++) {
            if (buf[i] === 0xff && buf[i + 1] === 0xd9) return { s, e: i + 2 };
          }
          return null;
        };

        const drain = () => {
          while (start < buffer.length) {
            const headerEnd = findHeaderEnd(buffer, start);
            if (headerEnd >= 0) {
              const len = contentLength(buffer, start, headerEnd);
              if (len != null && len > 0) {
                const jpegStart = headerEnd + 4;
                const jpegEnd = jpegStart + len;
                if (buffer.length < jpegEnd) break; // wait for the rest of the frame
                emit(buffer.subarray(jpegStart, jpegEnd));
                start = jpegEnd;
                continue;
              }
            } else if (buffer.length - start <= HEADER_WINDOW) {
              break; // header may simply be incomplete — wait for more bytes
            }
            // No usable header: header-less framing or a malformed part.
            const fr = scanJpeg(buffer, start);
            if (!fr) break;
            emit(buffer.subarray(fr.s, fr.e));
            start = fr.e;
          }
          // Compact: drop the consumed prefix so the buffer stays small.
          if (start > 0) {
            buffer = start < buffer.length ? buffer.slice(start) : new Uint8Array(0);
            start = 0;
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            const merged = new Uint8Array(buffer.length + value.length);
            merged.set(buffer);
            merged.set(value, buffer.length);
            buffer = merged;
            drain();
          }
        }
      } catch {
        // Aborted or network error
      } finally {
        scheduleRetry();
      }
    };
    void readStream();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
    };
  }, [streamUrl]);

  return { subscribeFrame, frame: null };
}
