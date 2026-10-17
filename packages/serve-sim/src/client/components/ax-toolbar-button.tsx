import { useState } from "react";
import { SquareMousePointer } from "lucide-react";
import { SimulatorToolbar } from "../simulator";
import { useAxSnapshotContext } from "../hooks/use-ax-snapshot";
import { inkFill, inkText } from "../utils/theme";

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
              background: hovered ? inkFill(0.12) : inkFill(0.08),
              color: inkText(0.95),
            }
          : undefined
      }
    >
      <SquareMousePointer size={19} strokeWidth={2} />
    </SimulatorToolbar.Button>
  );
}
