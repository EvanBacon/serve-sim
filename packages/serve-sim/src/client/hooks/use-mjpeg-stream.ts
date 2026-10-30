import { useCallback, useEffect, useRef, useState } from "react";
import { createMjpegFrameParser } from "../utils/mjpeg-frame-parser";
import { runStreamWithRetry, type StreamError } from "../utils/stream-retry";

/**
 * Fetches an MJPEG stream and parses out individual JPEG frames as blob URLs.
 * Chrome doesn't support multipart/x-mixed-replace in <img> tags, so we
 * manually read the stream and extract JPEG boundaries via
 * `createMjpegFrameParser` (see that module for the framing + accumulation
 * details — the parser is pure and unit-tested separately).
 *
 * Failures (a 503 with a reason, an empty response, a dropped stream) are
 * exposed as `error` and retried with exponential backoff capped at 10 s; see
 * `runStreamWithRetry`. `error` clears on the next frame.
 *
 * Screen config (dimensions / orientation) is no longer polled here — it
 * arrives over the input WebSocket — so this hook only deals with frame bytes.
 */
export function useMjpegStream(streamUrl: string | null, onStreamingChange?: (streaming: boolean) => void) {
  const streamingCallback = useRef(onStreamingChange);
  streamingCallback.current = onStreamingChange;
  const subscribersRef = useRef<Set<(blobUrl: string) => void>>(new Set());
  const [error, setError] = useState<StreamError | null>(null);

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
    setError(null);

    // ?raw=1 tells the server to use Content-Type application/octet-stream
    // instead of multipart/x-mixed-replace; WebKit refuses to expose
    // multipart bodies to fetch()'s ReadableStream.
    const fetchUrlObj = new URL(streamUrl);
    fetchUrlObj.searchParams.set("raw", "1");

    const emit = (jpeg: Uint8Array) => {
      streamingCallback.current?.(true);
      if (subscribersRef.current.size === 0) return;
      // Blob copies the bytes, so handing it a subarray view is safe even as
      // the underlying accumulation buffer is reused/compacted.
      const isPng = jpeg.length >= 8 && jpeg[0] === 0x89 && jpeg[1] === 0x50 && jpeg[2] === 0x4e && jpeg[3] === 0x47;
      const blobUrl = URL.createObjectURL(new Blob([jpeg as BlobPart], { type: isPng ? "image/png" : "image/jpeg" }));
      for (const cb of subscribersRef.current) cb(blobUrl);
    };

    void runStreamWithRetry({
      url: fetchUrlObj.toString(),
      signal: controller.signal,
      connect: () => {
        const parser = createMjpegFrameParser(emit);
        return (chunk) => parser.push(chunk);
      },
      onOpen: () => setError(null),
      onClose: () => streamingCallback.current?.(false),
      onError: (next) => {
        streamingCallback.current?.(false);
        setError(next);
      },
    });

    return () => {
      streamingCallback.current?.(false);
      controller.abort();
    };
  }, [streamUrl]);

  return { subscribeFrame, frame: null, error };
}
