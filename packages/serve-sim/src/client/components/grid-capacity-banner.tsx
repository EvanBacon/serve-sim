import { formatGridBytes, type MemoryReport } from "../utils/grid";

export function GridCapacityBanner({ report }: { report: MemoryReport | null }) {
  if (!report || report.totalBytes === 0) return null;
  const { estimatedAdditional, availableBytes, totalBytes, runningSimulators } = report;
  const usedFraction = Math.max(0, Math.min(1, 1 - availableBytes / totalBytes));
  const capacity = runningSimulators + estimatedAdditional;
  const dotColor =
    estimatedAdditional === 0 ? "#e66" : estimatedAdditional <= 1 ? "#e9a13b" : "#3b3";
  const barColor =
    usedFraction > 0.9 ? "#e66" : usedFraction > 0.75 ? "#e9a13b" : "#3b3";
  return (
    <div className="inline-flex items-center gap-1.5 px-2 py-[3px] rounded-full bg-[#101010] border border-[#222] font-mono text-[11px] text-white/70 leading-none">
      <span className="size-1.5 rounded-[3px] shrink-0" style={{ background: dotColor }} />
      <span>{runningSimulators}/{capacity} sims</span>
      <span className="text-white/40">·</span>
      <span className="text-white/55">{formatGridBytes(availableBytes)} free</span>
      <span aria-hidden className="ml-0.5 w-7 h-[3px] bg-[#1c1c1c] rounded-[2px] overflow-hidden inline-block">
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
