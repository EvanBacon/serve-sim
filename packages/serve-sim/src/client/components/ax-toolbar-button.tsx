import { useState } from "react";
import { SimulatorToolbar } from "serve-sim-client/simulator";
import { useAxSnapshotContext } from "../hooks/use-ax-snapshot";

export function AxToolbarButton({
  overlayEnabled,
  streaming,
  onToggleOverlay,
}: {
  overlayEnabled: boolean;
  streaming: boolean;
  onToggleOverlay: () => void;
}) {
  const { status } = useAxSnapshotContext();
  const [hovered, setHovered] = useState(false);
  const active = overlayEnabled && streaming;

  return (
    <SimulatorToolbar.Button
      aria-label={overlayEnabled ? "Hide accessibility overlay" : "Show accessibility overlay"}
      aria-pressed={overlayEnabled}
      title={status}
      onClick={onToggleOverlay}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={
        active
          ? {
              background: hovered ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.08)",
              color: "rgba(255,255,255,0.95)",
            }
          : undefined
      }
    >
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z" />
        <path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />
      </svg>
    </SimulatorToolbar.Button>
  );
}
