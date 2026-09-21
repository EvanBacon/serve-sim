import type { DeviceDisplayDescriptor } from "../utils/grid";
import { SimulatorToolbar } from "../simulator";

export function DeviceDisplayToolbarButton({
  displays,
  selectedId,
  onSelect,
}: {
  displays: DeviceDisplayDescriptor[];
  selectedId: string | null;
  onSelect: (display: DeviceDisplayDescriptor) => void;
}) {
  if (displays.length < 2) return null;

  return (
    <div
      role="group"
      aria-label="Device display"
      style={{ display: "inline-flex", alignItems: "center", gap: 0 }}
    >
      {displays.map((display) => {
        const selected = display.id === selectedId;
        return (
          <SimulatorToolbar.Button
            key={display.id}
            aria-label={`${display.name} display`}
            aria-pressed={selected}
            title={`${display.name} display`}
            onClick={() => onSelect(display)}
            style={
              selected
                ? {
                    background: "rgba(255,255,255,0.12)",
                    color: "rgba(255,255,255,0.95)",
                  }
                : undefined
            }
          >
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.2 }}>{display.name}</span>
          </SimulatorToolbar.Button>
        );
      })}
    </div>
  );
}
