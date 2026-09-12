import { useState } from "react";
import { Frame } from "lucide-react";
import { SimulatorToolbar } from "../simulator";

export function ChromeToolbarButton({
  hideChrome,
  onToggle,
}: {
  hideChrome: boolean;
  onToggle: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <SimulatorToolbar.Button
      aria-label={hideChrome ? "Show device frame" : "Hide device frame"}
      aria-pressed={hideChrome}
      title={hideChrome ? "Show device frame" : "Hide device frame"}
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={
        hideChrome
          ? {
              background: hovered ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.08)",
              color: "rgba(255,255,255,0.95)",
            }
          : undefined
      }
    >
      <Frame size={18} strokeWidth={2} />
    </SimulatorToolbar.Button>
  );
}
