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
        <path d="M3 8V5a2 2 0 0 1 2-2h3" />
        <path d="M16 3h3a2 2 0 0 1 2 2v3" />
        <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
        <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
        <circle cx="12" cy="12" r="3.5" />
      </svg>
    </SimulatorToolbar.Button>
  );
}
