import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamConfig } from "../types.js";
import { H264AnnexBAccessUnitParser } from "../utils/h264-annex-b";

type VideoFrameSubscriber = (frame: any) => void;

const FRAME_DURATION_US = 16_667;
const MAX_DECODE_QUEUE = 2;
const RETRY_DELAY_MS = 500;
const STREAM_STALL_MS = 5000;
const STARTUP_BYTE_TIMEOUT_MS = 3000;
const STARTUP_FRAME_TIMEOUT_MS = 6000;
const STARTUP_FAILURE_LIMIT = 3;

function videoStreamUrl(streamUrl: string): string {
  const url = new URL(streamUrl);
  url.pathname = url.pathname.replace(/\/stream\.mjpeg$/, "/stream.h264");
  url.search = "";
  return url.toString();
}

export function preserveStreamOrientation(
  prev: StreamConfig | null,
  next: StreamConfig,
): StreamConfig {
  if (next.orientation === undefined && prev?.orientation) {
    return { ...next, orientation: prev.orientation };
  }
  return next;
}

export function useH264Stream(streamUrl: string | null, enabled = true) {
  const [config, setConfig] = useState<StreamConfig | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const subscribersRef = useRef<Set<VideoFrameSubscriber>>(new Set());
  const configRef = useRef<StreamConfig | null>(null);

  const subscribeVideoFrame = useCallback((cb: VideoFrameSubscriber) => {
    subscribersRef.current.add(cb);
    return () => {
      subscribersRef.current.delete(cb);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !streamUrl) {
      setSupported(null);
      setConfig(null);
      configRef.current = null;
      return;
    }

    const VideoDecoderCtor = (window as any).VideoDecoder;
    const EncodedVideoChunkCtor = (window as any).EncodedVideoChunk;
    if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
      setSupported(false);
      setConfig(null);
      configRef.current = null;
      return;
    }

    configRef.current = null;
    setConfig(null);
    setSupported(true);

    const controller = new AbortController();
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let decoder: any = null;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let startupFailures = 0;
    let hasDecodedFrame = false;
    const baseUrl = streamUrl.replace(/\/stream\.mjpeg$/, "");

    const applyConfig = (next: StreamConfig) => {
      if (next.width <= 0 || next.height <= 0) return;
      const prev = configRef.current;
      const normalized = preserveStreamOrientation(prev, next);
      if (
        prev &&
        prev.width === normalized.width &&
        prev.height === normalized.height &&
        prev.orientation === normalized.orientation
      ) {
        return;
      }
      configRef.current = normalized;
      setConfig(normalized);
    };

    const fetchConfig = () => {
      fetch(`${baseUrl}/config`, { signal: controller.signal })
        .then((r) => r.json())
        .then(applyConfig)
        .catch(() => {});
    };
    fetchConfig();
    const configInterval = setInterval(fetchConfig, 1000);

    const closeDecoder = async (target?: any) => {
      const current = target ?? decoder;
      if (!current) return;
      if (!target || decoder === target) decoder = null;
      try {
        if (current.state !== "closed") current.close();
      } catch {}
    };

    const markUnsupported = () => {
      setSupported(false);
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      controller.abort();
      void closeDecoder();
    };

    const recordStartupFailure = () => {
      if (stopped || controller.signal.aborted) return true;
      startupFailures++;
      if (startupFailures >= STARTUP_FAILURE_LIMIT) {
        markUnsupported();
        return true;
      }
      return false;
    };

    const scheduleRetry = (delayMs = RETRY_DELAY_MS) => {
      if (stopped || controller.signal.aborted || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void readStream();
      }, delayMs);
    };

    const restartStream = () => {
      if (stopped || controller.signal.aborted) return;
      void activeReader?.cancel().catch(() => {});
      void closeDecoder();
      scheduleRetry();
    };

    const emitFrame = (frame: any) => {
      hasDecodedFrame = true;
      startupFailures = 0;
      const width = Number(frame.displayWidth || frame.codedWidth || 0);
      const height = Number(frame.displayHeight || frame.codedHeight || 0);
      if (width > 0 && height > 0) {
        applyConfig({ width, height });
      }

      const subscribers = [...subscribersRef.current];
      try {
        for (const subscriber of subscribers) subscriber(frame);
      } finally {
        frame.close?.();
      }
    };

    const readStream = async () => {
      let timestamp = 0;
      let sawKeyFrame = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let readDecoder: any = null;
      let lastByteAt = Date.now();
      let sawBytes = false;
      let startupFailureRecorded = false;
      let startupByteTimer: ReturnType<typeof setTimeout> | null = null;
      let startupFrameTimer: ReturnType<typeof setTimeout> | null = null;
      let stallTimer: ReturnType<typeof setInterval> | null = null;
      await closeDecoder();

      const recordReadStartupFailure = () => {
        if (startupFailureRecorded) return stopped || controller.signal.aborted;
        startupFailureRecorded = true;
        return recordStartupFailure();
      };

      try {
        decoder = new VideoDecoderCtor({
          output: emitFrame,
          error: (err: unknown) => {
            console.warn("[android-video]", err);
            if (!hasDecodedFrame && recordReadStartupFailure()) return;
            restartStream();
          },
        });
        readDecoder = decoder;
        try {
          decoder.configure({
            codec: "avc1.42E01E",
            hardwareAcceleration: "prefer-hardware",
            optimizeForLatency: true,
            avc: { format: "annexb" },
          });
        } catch (err) {
          console.warn("[android-video]", err);
          markUnsupported();
          return;
        }

        const parser = new H264AnnexBAccessUnitParser((accessUnit) => {
          if (!sawKeyFrame && accessUnit.type !== "key") return;
          sawKeyFrame = true;
          const chunkTimestamp = timestamp;
          timestamp += FRAME_DURATION_US;
          if (!decoder || decoder.state === "closed") return;
          if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE && accessUnit.type !== "key") return;
          try {
            decoder.decode(new EncodedVideoChunkCtor({
              type: accessUnit.type,
              timestamp: chunkTimestamp,
              duration: FRAME_DURATION_US,
              data: accessUnit.data,
            }));
          } catch (err) {
            console.warn("[android-video]", err);
            restartStream();
          }
        });

        const res = await fetch(videoStreamUrl(streamUrl), { signal: controller.signal });
        if (!res.ok || !res.body) {
          if (res.status === 404 || res.status === 415) {
            markUnsupported();
          } else if (!recordReadStartupFailure()) {
            scheduleRetry();
          }
          return;
        }

        reader = res.body.getReader();
        activeReader = reader;
        startupByteTimer = setTimeout(() => {
          if (sawBytes || stopped || controller.signal.aborted) return;
          if (!recordReadStartupFailure()) restartStream();
        }, STARTUP_BYTE_TIMEOUT_MS);
        startupFrameTimer = setTimeout(() => {
          if (hasDecodedFrame || stopped || controller.signal.aborted) return;
          if (!recordReadStartupFailure()) restartStream();
        }, STARTUP_FRAME_TIMEOUT_MS);
        stallTimer = setInterval(() => {
          if (Date.now() - lastByteAt > STREAM_STALL_MS) restartStream();
        }, 1000);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) {
            sawBytes = true;
            if (startupByteTimer) {
              clearTimeout(startupByteTimer);
              startupByteTimer = null;
            }
            lastByteAt = Date.now();
            parser.push(value);
          }
        }
        if (activeReader === reader) activeReader = null;
        parser.flush();
      } catch {
        // Aborted or network error; retry below unless cleanup is in progress.
        if (!sawBytes) recordReadStartupFailure();
      } finally {
        if (startupByteTimer) clearTimeout(startupByteTimer);
        if (startupFrameTimer) clearTimeout(startupFrameTimer);
        if (stallTimer) clearInterval(stallTimer);
        if (reader && activeReader === reader) activeReader = null;
        await closeDecoder(readDecoder);
        scheduleRetry();
      }
    };

    void readStream();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
      clearInterval(configInterval);
      void closeDecoder();
    };
  }, [enabled, streamUrl]);

  return { config, subscribeVideoFrame, supported };
}
