import { useEffect, useRef } from "react";
import {
  AvccDemuxer,
  avcCodecString,
  isAvccSupported,
  type AvccChunkType,
} from "../avcc-codec.js";

export interface UseAvccStreamOptions {
  /** Base server URL, e.g. "http://localhost:3100". */
  url: string;
  /** When false, the hook tears down any active decode and does nothing. */
  enabled: boolean;
  /** Target canvas the decoded frames are painted into. */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Called the first time any frame (seed or decoded) is painted. */
  onFirstFrame?: () => void;
  /** Called on every painted frame — drives the FPS counter / staleness check. */
  onFrame?: () => void;
  /** Called with a human-readable message when the decode pipeline fails. */
  onError?: (message: string) => void;
  /**
   * Called when the WebCodecs decoder itself fails fatally (a `VideoDecoder`
   * `error` event or a `configure()` throw) — as opposed to a network/stream
   * hiccup. When provided it *replaces* {@link onError} for these failures: the
   * consumer is expected to downgrade to MJPEG (hardware H.264 decode is no
   * longer viable — e.g. a screen recorder starving VideoToolbox), so the
   * failure is recovered from rather than surfaced as a user-facing error.
   */
  onDecoderError?: () => void;
}

const RETRY_DELAY_MS = 1000;
/** ~60fps monotonic tick. Never displayed — WebCodecs just needs increasing PTS. */
const FRAME_DURATION_US = 16_667;

/**
 * Decode an H.264 `/stream.avcc` feed into `canvasRef` via WebCodecs.
 *
 * The decode pipeline is keyed only on `url` and `enabled`; the callbacks are
 * read through a ref so passing fresh closures every render does not restart the
 * stream. A no-op when AVCC is unsupported, `enabled` is false, or `url` is
 * empty (a device-less preview config would otherwise fetch a relative
 * `undefined/stream.avcc` from the page origin).
 */
export function useAvccStream({
  url,
  enabled,
  canvasRef,
  onFirstFrame,
  onFrame,
  onError,
  onDecoderError,
}: UseAvccStreamOptions): void {
  // Latest-callback ref: keeps the decode effect off the callback identities.
  const callbacks = useRef({ onFirstFrame, onFrame, onError, onDecoderError });
  callbacks.current = { onFirstFrame, onFrame, onError, onDecoderError };

  useEffect(() => {
    if (!enabled || !url || !isAvccSupported()) return;

    const controller = new AbortController();
    const demuxer = new AvccDemuxer();
    let stopped = false;
    let painted = false;
    let timestamp = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let decoder: VideoDecoder | null = null;

    const isLive = () => !stopped && !controller.signal.aborted;

    // A fatal decode failure routes to onDecoderError (downgrade to MJPEG) when
    // a handler is wired, else surfaces as a user-facing error. Routing to both
    // would flash a red overlay over the stream the parent is about to recover.
    const reportDecodeFailure = (message: string) => {
      if (callbacks.current.onDecoderError) callbacks.current.onDecoderError();
      else callbacks.current.onError?.(message);
    };

    const paint = (source: CanvasImageSource, width: number, height: number) => {
      if (!isLive()) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(source, 0, 0, width, height);
      callbacks.current.onFrame?.();
      if (!painted) {
        painted = true;
        callbacks.current.onFirstFrame?.();
      }
    };

    const makeDecoder = () =>
      new VideoDecoder({
        output: (frame) => {
          try {
            if (isLive()) paint(frame, frame.displayWidth, frame.displayHeight);
          } finally {
            frame.close();
          }
        },
        error: (err) => reportDecodeFailure(`decoder: ${err.message}`),
      });

    const paintSeed = async (jpeg: Uint8Array) => {
      // JPEG seed — paint immediately for an instant first frame.
      const bitmap = await createImageBitmap(
        new Blob([jpeg as BlobPart], { type: "image/jpeg" }),
      );
      try {
        if (isLive()) paint(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    };

    const configureDecoder = (description: Uint8Array) => {
      if (!decoder || decoder.state === "closed") decoder = makeDecoder();
      try {
        decoder.configure({
          codec: avcCodecString(description),
          description,
          // `optimizeFor` is a valid runtime hint not yet in lib.dom's types.
          optimizeFor: "latency",
          hardwareAcceleration: "prefer-hardware",
        } as VideoDecoderConfig & { optimizeFor: "latency" });
      } catch (err) {
        reportDecodeFailure(`config: ${(err as Error).message}`);
      }
    };

    const decodeFrame = (type: "keyframe" | "delta", data: Uint8Array) => {
      if (decoder?.state !== "configured") return;
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: type === "keyframe" ? "key" : "delta",
            timestamp,
            data,
          }),
        );
        timestamp += FRAME_DURATION_US;
      } catch {
        /* drop undecodable frame */
      }
    };

    const handleChunk = (type: AvccChunkType, payload: Uint8Array) => {
      switch (type) {
        case "seed":
          void paintSeed(payload).catch(() => {});
          return;
        case "description":
          configureDecoder(payload);
          return;
        case "keyframe":
        case "delta":
          decodeFrame(type, payload);
          return;
      }
    };

    const scheduleRetry = () => {
      if (!isLive() || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void read();
      }, RETRY_DELAY_MS);
    };

    const read = async () => {
      // Each HTTP response is a self-contained stream that opens with its own
      // description — drop any partial bytes left over from a dropped connection.
      demuxer.reset();
      try {
        const res = await fetch(`${url}/stream.avcc`, {
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        if (!reader) return;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          for (const chunk of demuxer.push(value)) {
            handleChunk(chunk.type, chunk.payload);
          }
        }
      } catch {
        /* aborted or network error — falls through to retry */
      } finally {
        if (isLive()) scheduleRetry();
      }
    };

    void read();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
      demuxer.reset();
      if (decoder && decoder.state !== "closed") {
        try {
          decoder.close();
        } catch {
          /* already closed */
        }
      }
      decoder = null;
    };
  }, [url, enabled, canvasRef]);
}
