export function StreamStatusPill({ streaming }: { streaming: boolean }) {
  const color = streaming ? "#4ade80" : "#8e8e93";
  const label = streaming ? "live" : "connecting";

  return (
    <span
      data-testid="stream-status-pill"
      className="inline-flex items-center gap-[5px] text-[12px] font-mono font-medium leading-none whitespace-nowrap"
      style={{ color }}
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full [transition:background_0.18s_ease]"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}
