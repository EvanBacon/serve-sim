import { useEffect, useRef, useState } from "react";

// Type-only — the sampler's node: imports must not reach the client bundle.
import type { MetricSample, MetricsMeta } from "../../cpu-mem-sampler";
import { openHostEventStream } from "../utils/exec";

export type { MetricSample, MetricsMeta };

// ~1 minute of history at 1s cadence.
const MAX_POINTS = 60;
// The sampler emits ~1/s, but a single healthy tick can take up to ~7s (the poll interval plus the
// ps and footprint timeouts), so only flag the readout stale well past that worst case. The backend
// also goes quiet when no user app is foreground (or the app exits), so silence is expected, not rare.
const STALE_AFTER_MS = 8_000;

/**
 * The transport strips SSE `event:` lines, so meta and sample frames both
 * arrive as messages, discriminated by shape.
 */
export function useMetricsStream(path: string): {
  meta: MetricsMeta | null;
  latest: MetricSample | null;
  history: MetricSample[];
  errored: boolean;
  stale: boolean;
} {
  const [meta, setMeta] = useState<MetricsMeta | null>(null);
  const [history, setHistory] = useState<MetricSample[]>([]);
  const [errored, setErrored] = useState(false);
  const [stale, setStale] = useState(false);
  const lastSampleAt = useRef(0);

  useEffect(() => {
    // Reset so a device switch drops the previous device's samples.
    setMeta(null);
    setHistory([]);
    setErrored(false);
    setStale(false);
    lastSampleAt.current = 0;
    const stream = openHostEventStream(path);
    stream.onmessage = ({ data }) => {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        setErrored(false);
        if ("schemaVersion" in parsed) setMeta(parsed as unknown as MetricsMeta);
        else if ("t" in parsed) {
          const sample = parsed as unknown as MetricSample;
          lastSampleAt.current = Date.now();
          setStale(false);
          setHistory((prev) => {
            // Reset only on a real foreground app switch. Compare against the last
            // *known* app, ignoring the sampler's intermediate null aggregate when it
            // briefly loses the frontmost signal (e.g. app A -> home -> app B), so the
            // series isn't wiped on every open/close but still resets between two apps.
            const lastBundleId =
              [...prev].reverse().find((s) => s.bundleId !== null)?.bundleId ?? null;
            const appSwitched =
              lastBundleId !== null &&
              sample.bundleId !== null &&
              lastBundleId !== sample.bundleId;
            return [...(appSwitched ? [] : prev), sample].slice(-MAX_POINTS);
          });
        }
      } catch {
        // ignore a malformed frame
      }
    };
    stream.onerror = () => setErrored(true);
    // Flag the readout stale once samples stop arriving, so the last value isn't shown as live.
    const watchdog = setInterval(() => {
      if (lastSampleAt.current > 0 && Date.now() - lastSampleAt.current > STALE_AFTER_MS) {
        setStale(true);
      }
    }, 1_000);
    return () => {
      stream.close();
      clearInterval(watchdog);
    };
  }, [path]);

  return { meta, latest: history.at(-1) ?? null, history, errored, stale };
}
