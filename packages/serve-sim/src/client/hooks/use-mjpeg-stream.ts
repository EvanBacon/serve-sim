import { useCallback, useEffect, useRef } from "react";
import { createMjpegFrameParser } from "../utils/mjpeg-frame-parser";

/**
 * Fetches an MJPEG stream and parses out individual JPEG frames as blob URLs.
 * Chrome doesn't support multipart/x-mixed-replace in <img> tags, so we
 * manually read the stream and extract JPEG boundaries via
 * `createMjpegFrameParser` (see that module for the framing + accumulation
 * details — the parser is pure and unit-tested separately).
 *
 * Screen config (dimensions / orientation) is no longer polled here — it
 * arrives over the input WebSocket — so this hook only deals with frame bytes.
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

        const parser = createMjpegFrameParser(emit);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) parser.push(value);
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
