import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamConfig } from "serve-sim-client/simulator";
import { H264AnnexBAccessUnitParser } from "../utils/h264-annex-b";

type VideoFrameSubscriber = (frame: any) => void;

const FRAME_DURATION_US = 16_667;
const MAX_DECODE_QUEUE = 2;

function videoStreamUrl(streamUrl: string): string {
  const url = new URL(streamUrl);
  url.pathname = url.pathname.replace(/\/stream\.mjpeg$/, "/stream.h264");
  url.search = "";
  return url.toString();
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
    const baseUrl = streamUrl.replace(/\/stream\.mjpeg$/, "");

    const applyConfig = (next: StreamConfig) => {
      if (next.width <= 0 || next.height <= 0) return;
      const prev = configRef.current;
      if (
        prev &&
        prev.width === next.width &&
        prev.height === next.height &&
        prev.orientation === next.orientation
      ) {
        return;
      }
      configRef.current = next;
      setConfig(next);
    };

    const fetchConfig = () => {
      fetch(`${baseUrl}/config`, { signal: controller.signal })
        .then((r) => r.json())
        .then(applyConfig)
        .catch(() => {});
    };
    fetchConfig();
    const configInterval = setInterval(fetchConfig, 1000);

    const closeDecoder = async () => {
      if (!decoder) return;
      const current = decoder;
      decoder = null;
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

    const scheduleRetry = () => {
      if (stopped || controller.signal.aborted || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void readStream();
      }, 250);
    };

    const emitFrame = (frame: any) => {
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
      await closeDecoder();

      try {
        decoder = new VideoDecoderCtor({
          output: emitFrame,
          error: (err: unknown) => {
            console.warn("[android-video]", err);
            markUnsupported();
          },
        });
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
          if (decoder?.decodeQueueSize >= MAX_DECODE_QUEUE && accessUnit.type !== "key") return;
          try {
            decoder.decode(new EncodedVideoChunkCtor({
              type: accessUnit.type,
              timestamp: chunkTimestamp,
              duration: FRAME_DURATION_US,
              data: accessUnit.data,
            }));
          } catch (err) {
            console.warn("[android-video]", err);
            markUnsupported();
          }
        });

        const res = await fetch(videoStreamUrl(streamUrl), { signal: controller.signal });
        if (!res.ok || !res.body) {
          if (res.status === 404 || res.status === 415) markUnsupported();
          scheduleRetry();
          return;
        }

        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) parser.push(value);
        }
        parser.flush();
      } catch {
        // Aborted or network error; retry below unless cleanup is in progress.
      } finally {
        await closeDecoder();
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
