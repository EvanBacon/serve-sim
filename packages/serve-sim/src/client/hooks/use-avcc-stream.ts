import { useEffect, useState } from "react";
import { isAvccSupported } from "serve-sim-client/simulator";
import type { StreamConfig } from "serve-sim-client/simulator";

/**
 * Relay coordinator for the `/stream.avcc` H.264 stream.
 *
 * Unlike {@link useMjpegStream}, the frame decode lives view-side in
 * `SimulatorView`'s `useAvccStream` (a stateful WebCodecs pipeline that paints
 * straight into a <canvas>), so this hook does not pull video bytes itself. It
 * owns the two things the parent still needs centrally:
 *
 *   - `supported`: whether the browser can decode H.264 via WebCodecs. Stable
 *     for the lifetime of the page, so it's safe to branch render trees on.
 *   - `config`: the simulator screen dimensions / orientation, polled from
 *     `/config` exactly like the MJPEG relay so layout follows rotations.
 *
 * When `supported` is false the caller should fall back to {@link useMjpegStream}.
 */
export function useAvccStream(streamUrl: string | null) {
  const [supported] = useState(isAvccSupported);
  const [config, setConfig] = useState<StreamConfig | null>(null);

  useEffect(() => {
    if (!streamUrl || !supported) return;
    const controller = new AbortController();

    const baseUrl = streamUrl.replace(/\/stream\.(mjpeg|avcc)$/, "");
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

    return () => {
      controller.abort();
      clearInterval(configInterval);
    };
  }, [streamUrl, supported]);

  return { supported, config };
}
