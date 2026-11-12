import { useEffect, useRef, useState } from "react";
import { Circle, LoaderCircle, Square } from "lucide-react";
import { SimulatorToolbar } from "../simulator";
import type { ScreenRecordingState } from "../hooks/use-screen-recording";

const RECORDING_RED = "#ff3b30";
const MOTION_MS = 240;

/** `m:ss` elapsed since `startedAt`. */
export function formatRecordingElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Toolbar record toggle: a circle when idle; while recording a red stop
 * square with an elapsed timer; a spinner while starting or saving.
 *
 * Idle ↔ recording (and back) animates over 240ms ease-out: the glyph morphs,
 * the timer fades/slides in, and the control's width grows so the actions
 * pill does not jump. `prefers-reduced-motion: reduce` crossfades only.
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
  const startedAt = state.status === "recording" ? state.startedAt : null;
  const [now, setNow] = useState(() => Date.now());
  // Keep the last painted elapsed during render so the close animation
  // never flashes "0:00" (effect cleanup would run after paint).
  const lastElapsedRef = useRef("0:00");
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt != null) {
    lastElapsedRef.current = formatRecordingElapsed(now - startedAt);
  }
  const elapsed = lastElapsedRef.current;

  const label = recording
    ? "Stop recording"
    : state.status === "saving"
      ? "Saving recording…"
      : state.status === "starting"
        ? "Starting recording…"
        : "Record screen";

  return (
    <SimulatorToolbar.Button
      className="serve-sim-record-btn"
      data-recording={recording ? "true" : "false"}
      data-busy={busy ? "true" : "false"}
      aria-label={label}
      aria-pressed={recording}
      title={label}
      forceDisabled={busy}
      onClick={(e) => { e.preventDefault(); onToggle(); }}
      style={
        recording
          ? { color: RECORDING_RED, transition: `background-color 0.15s, color ${MOTION_MS}ms ease-out` }
          : { transition: `background-color 0.15s, color ${MOTION_MS}ms ease-out` }
      }
    >
      <span className="serve-sim-record-icon" aria-hidden="true">
        <LoaderCircle size={18} strokeWidth={2} className="serve-sim-record-spinner animate-spin" />
        <svg
          className="serve-sim-record-glyph serve-sim-record-glyph--morph"
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
        >
          {/* Presentation attrs match the CSS idle rule so a no-stylesheet fallback still looks idle. */}
          <rect className="serve-sim-record-glyph__shape" x="1" y="1" width="16" height="16" rx="8" />
        </svg>
        <span className="serve-sim-record-glyph serve-sim-record-glyph--fade">
          <Circle size={18} strokeWidth={2} className="serve-sim-record-glyph--idle" />
          <Square size={14} strokeWidth={0} fill="currentColor" className="serve-sim-record-glyph--stop" />
        </span>
      </span>
      <span className="serve-sim-record-timer-slot" data-open={recording ? "true" : "false"}>
        <span className="serve-sim-record-timer-clip">
          <span
            className="serve-sim-record-timer"
            data-testid="recording-elapsed"
            aria-hidden={!recording}
          >
            {elapsed}
          </span>
        </span>
      </span>
    </SimulatorToolbar.Button>
  );
}
