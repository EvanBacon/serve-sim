import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useMetricsStream } from "../hooks/use-metrics-stream";
import { formatCpu, formatMem, sparklinePath } from "../utils/format-metrics";
import { simEndpoint } from "../utils/sim-endpoint";
import { CollapsibleSection } from "./collapsible-section";

const SPARK_W = 96;
const SPARK_H = 24;

/** Live CPU/memory readout for the sim's user app, with a sparkline for each. */
export function MetricsTool({
  udid,
  currentAppBundleId,
  metricsEndpoint,
}: {
  udid: string;
  currentAppBundleId: string | null;
  metricsEndpoint?: string;
}) {
  const path = useMemo(
    () => metricsEndpoint ?? `${simEndpoint("metrics")}?device=${encodeURIComponent(udid)}`,
    [metricsEndpoint, udid],
  );
  const { meta, latest, history, errored, stale } = useMetricsStream(path);
  const [open, setOpen] = useState(true);
  // Live only while the backend actually scoped to a user app: each sample carries that app's
  // bundleId, and null when a system app is in front (those run outside the sampler's reach) or
  // nothing is running. Keying on the sampler's own output keeps this from drifting from what it can
  // measure; currentAppBundleId (from /appstate) only words the idle reason.
  const live = latest !== null && latest.bundleId !== null && !errored && !stale;
  const foregroundIsSystemApp =
    currentAppBundleId != null && currentAppBundleId.startsWith("com.apple.");
  // When there's nothing to show, a header glyph carries the reason on hover instead of a body line.
  const idleReason = errored
    ? "The metrics stream disconnected"
    : foregroundIsSystemApp
      ? "Only your app is measured; a system app is in the foreground"
      : "Waiting for CPU / memory data";

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      bodyClassName={live ? undefined : "hidden"}
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Activity
          </span>
          {live
            ? !open && (
                <span className="text-[11px] text-white/40 tabular-nums text-right">
                  {formatCpu(latest.cpuPct)} · {formatMem(latest.memBytes)}
                </span>
              )
            : (
                <span
                  data-metrics-warning
                  role="status"
                  className="group relative justify-self-end inline-flex items-center"
                >
                  <TriangleAlert aria-hidden="true" className="w-3.5 h-3.5 text-amber-400" />
                  <span className="sr-only">{idleReason}</span>
                  <span className="pointer-events-none absolute right-0 top-full z-10 mt-1 hidden w-max max-w-[220px] rounded-md bg-black/90 px-2 py-1 text-[11px] leading-snug text-white/90 shadow-lg group-hover:block">
                    {idleReason}
                  </span>
                </span>
              )}
        </>
      }
    >
      {live ? (
        <>
          <MetricRow
            label="CPU"
            value={formatCpu(latest.cpuPct)}
            hint={meta ? `${meta.hostCores} cores` : undefined}
            values={history.map((s) => s.cpuPct)}
            className="text-emerald-400"
          />
          <MetricRow
            label="Memory"
            value={formatMem(latest.memBytes)}
            values={history.map((s) => s.memBytes)}
            className="text-sky-400"
          />
        </>
      ) : null}
    </CollapsibleSection>
  );
}

/** One labeled metric: its current value with a sparkline of recent history. */
function MetricRow({
  label,
  value,
  hint,
  values,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  values: number[];
  className: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-white/50 text-[11px]">{label}</span>
        <span className="tabular-nums text-[11px]">
          {value}
          {hint && <span className="text-white/30 text-[11px] ml-1.5">{hint}</span>}
        </span>
      </div>
      <Sparkline values={values} className={className} />
    </div>
  );
}

/** Minimal filled-area sparkline for a series of values. */
function Sparkline({ values, className }: { values: number[]; className: string }) {
  const line = sparklinePath(values, SPARK_W, SPARK_H);
  // Close the line down to the baseline and back to fill the area under it.
  const area = line ? `${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z` : "";
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className={`w-full h-8 ${className}`}
    >
      <path d={area} fill="currentColor" opacity={0.12} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
