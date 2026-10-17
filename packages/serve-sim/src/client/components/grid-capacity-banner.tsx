import { formatGridBytes, type MemoryReport } from "../utils/grid";

const DANGER = "var(--serve-sim-danger)";
const CAUTION = "var(--serve-sim-caution)";
const OK = "var(--serve-sim-success)";

export function GridCapacityBanner({ report }: { report: MemoryReport | null }) {
  if (!report || report.totalBytes === 0) return null;
  const { estimatedAdditional, availableBytes, totalBytes, runningSimulators } = report;
  const usedFraction = Math.max(0, Math.min(1, 1 - availableBytes / totalBytes));
  const capacity = runningSimulators + estimatedAdditional;
  const dotColor =
    estimatedAdditional === 0 ? DANGER : estimatedAdditional <= 1 ? CAUTION : OK;
  const barColor =
    usedFraction > 0.9 ? DANGER : usedFraction > 0.75 ? CAUTION : OK;
  return (
    <div className="inline-flex max-w-full min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden whitespace-nowrap px-2 py-[3px] rounded-full bg-panel-deep border border-ink/10 font-mono text-[11px] text-ink-70 leading-none">
      <span className="size-1.5 rounded-[3px] shrink-0" style={{ background: dotColor }} />
      <span className="min-w-0 truncate">
        <span>{runningSimulators}/{capacity} sims</span>
        <span className="text-ink-40"> · </span>
        <span className="text-ink-55">{formatGridBytes(availableBytes)} free</span>
      </span>
      <span aria-hidden className="ml-0.5 w-7 h-[3px] shrink-0 bg-ink/10 rounded-[2px] overflow-hidden inline-block">
        <span
          className="block h-full transition-[width,background] duration-300 ease-out"
          style={{
            width: `${(usedFraction * 100).toFixed(1)}%`,
            background: barColor,
          }}
        />
      </span>
    </div>
  );
}
