import { useEffect, useState } from "react";
import { Circle, LoaderCircle, Square } from "lucide-react";
import { SimulatorToolbar } from "../simulator";
import type { ScreenRecordingState } from "../hooks/use-screen-recording";

const RECORDING_RED = "#ff3b30";

/** `m:ss` elapsed since `startedAt`. */
export function formatRecordingElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Toolbar record toggle: a circle when idle; while recording a red stop
 * square with an elapsed timer; a spinner while starting or saving.
 */
export function RecordToolbarButton({
  state,
  onToggle,
}: {
  state: ScreenRecordingState;
  onToggle: () => void;
}) {
  const recording = state.status === "recording";
  const busy = state.status === "starting" || state.status === "saving";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [recording]);

  const label = recording
    ? "Stop recording"
    : state.status === "saving"
      ? "Saving recording…"
      : state.status === "starting"
        ? "Starting recording…"
        : "Record screen";

  return (
    <SimulatorToolbar.Button
      aria-label={label}
      aria-pressed={recording}
      title={label}
      forceDisabled={busy}
      onClick={(e) => { e.preventDefault(); onToggle(); }}
      style={recording ? { color: RECORDING_RED, gap: 4 } : undefined}
    >
      {busy ? (
        <LoaderCircle size={18} strokeWidth={2} className="animate-spin" />
      ) : recording ? (
        <>
          <Square size={14} strokeWidth={0} fill="currentColor" />
          <span
            data-testid="recording-elapsed"
            style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", lineHeight: "18px" }}
          >
            {formatRecordingElapsed(now - state.startedAt)}
          </span>
        </>
      ) : (
        <Circle size={18} strokeWidth={2} />
      )}
    </SimulatorToolbar.Button>
  );
}
