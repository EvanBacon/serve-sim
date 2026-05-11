import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamConfig } from "serve-sim-client/simulator";

/**
 * Fetches an MJPEG stream and parses out individual JPEG frames as blob URLs.
 * Chrome doesn't support multipart/x-mixed-replace in <img> tags,
 * so we manually read the stream and extract JPEG boundaries.
 */
export function useMjpegStream(streamUrl: string | null) {
  const [config, setConfig] = useState<StreamConfig | null>(null);
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

    // Poll config for screen dimensions + requested orientation.
    const baseUrl = streamUrl.replace(/\/stream\.mjpeg$/, "");
    const applyConfig = (c: StreamConfig) => {
      if (c.width <= 0 || c.height <= 0) return;
      setConfig((prev) =>
        prev &&
        prev.width === c.width &&
        prev.height === c.height &&
        prev.orientation === c.orientation
          ? prev
          : c,
      );
    };
    const fetchConfig = () => {
      fetch(`${baseUrl}/config`, { signal: controller.signal })
        .then((r) => r.json())
        .then(applyConfig)
        .catch(() => {});
    };
    fetchConfig();
    const configInterval = setInterval(fetchConfig, 1000);

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
    const readStream = async () => {
      try {
        const res = await fetch(fetchUrl, { signal: controller.signal });
        const reader = res.body?.getReader();
        if (!reader) {
          scheduleRetry();
          return;
        }

        let buffer = new Uint8Array(0);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Append new data
          const newBuf = new Uint8Array(buffer.length + value.length);
          newBuf.set(buffer);
          newBuf.set(value, buffer.length);
          buffer = newBuf;

          // Look for JPEG frames: find Content-Length or JPEG markers (FFD8...FFD9)
          // Simpler approach: split on boundary markers and extract JPEG data
          while (true) {
            // Find first JPEG start (FF D8)
            let jpegStart = -1;
            for (let i = 0; i < buffer.length - 1; i++) {
              if (buffer[i] === 0xff && buffer[i + 1] === 0xd8) {
                jpegStart = i;
                break;
              }
            }
            if (jpegStart === -1) break;

            // Find JPEG end (FF D9) after the start
            let jpegEnd = -1;
            for (let i = jpegStart + 2; i < buffer.length - 1; i++) {
              if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) {
                jpegEnd = i + 2;
                break;
              }
            }
            if (jpegEnd === -1) break;

            // Extract the JPEG frame
            const jpeg = buffer.slice(jpegStart, jpegEnd);
            buffer = buffer.slice(jpegEnd);

            const blob = new Blob([jpeg], { type: "image/jpeg" });
            const blobUrl = URL.createObjectURL(blob);
            if (subscribersRef.current.size === 0) {
              URL.revokeObjectURL(blobUrl);
              continue;
            }
            for (const cb of subscribersRef.current) {
              cb(blobUrl);
            }
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
      clearInterval(configInterval);
    };
  }, [streamUrl]);

  return { subscribeFrame, frame: null, config };
}
