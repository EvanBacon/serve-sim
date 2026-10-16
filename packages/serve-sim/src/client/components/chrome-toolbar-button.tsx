import { useState } from "react";
import { Frame } from "lucide-react";
import { SimulatorToolbar } from "../simulator";
import { inkFill, inkText } from "../utils/theme";

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
              background: hovered ? inkFill(0.12) : inkFill(0.08),
              color: inkText(0.95),
            }
          : undefined
      }
    >
      <Frame size={18} strokeWidth={2} />
    </SimulatorToolbar.Button>
  );
}
