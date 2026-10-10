import type { StreamError } from "../utils/stream-retry";

/** One-line label for a stream error, e.g. "3D model_lookup" or "HTTP 503". */
function streamErrorLabel(error: StreamError): string {
  if (error.stage) return `error · ${error.stage}`;
  if (error.status) return `error · ${error.status}`;
  return "error · no response";
}

export function StreamStatusPill({ streaming, error }: { streaming: boolean; error?: StreamError | null }) {
  const failed = !streaming && error != null;
  const color = streaming ? "#4ade80" : failed ? "#f87171" : "#8e8e93";
  const label = streaming ? "live" : failed ? streamErrorLabel(error) : "connecting";

  return (
    <span
      data-testid="stream-status-pill"
      className="inline-flex items-center gap-[5px] text-[12px] font-mono font-medium leading-none whitespace-nowrap"
      style={{ color }}
      title={failed ? error.reason : undefined}
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
