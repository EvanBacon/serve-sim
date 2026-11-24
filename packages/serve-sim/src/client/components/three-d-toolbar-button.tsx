import { useState } from "react";
import { SimulatorToolbar } from "../simulator";
import { inkFill, inkText } from "../utils/theme";

/** Toolbar toggle for the 3D device view (same look as the device-frame toggle). */
export function ThreeDToolbarButton({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const label = active ? "Exit 3D view" : "View in 3D";
  return (
    <SimulatorToolbar.Button
      aria-label={label}
      aria-pressed={active}
      title={active ? "Exit 3D (Esc)" : "View in 3D"}
      onClick={onToggle}
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
      <span aria-hidden className="text-[12px] font-semibold leading-none tracking-[-0.01em]">
        3D
      </span>
    </SimulatorToolbar.Button>
  );
}
