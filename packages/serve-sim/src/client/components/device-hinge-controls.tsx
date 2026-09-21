import { useEffect, useState, type CSSProperties } from "react";
import { SimulatorToolbar } from "../simulator";
import { bindAltHeld } from "../utils/bind-alt-held";

const poses = [
  { id: "closed", label: "Folded", angle: 0 },
  { id: "book", label: "Cracked open", angle: 130 },
  { id: "open", label: "Fully open", angle: 180 },
] as const;

const pressedStyle: CSSProperties = { color: "#0a84ff" };

function PoseIcon({ pose }: { pose: string }) {
  return <svg width="18" height="18" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {pose === "closed" ? <><rect x="9" y="4" width="14" height="24" rx="2.5" /><path d="M14 25h4" /></>
      : pose === "book" ? <path d="M16 7 4.5 4.5Q3 4.2 3 6v20q0 1.8 1.5 1.5L16 25l11.5 2.5Q29 27.8 29 26V6q0-1.8-1.5-1.5L16 7v18" />
      : <><rect x="2" y="4" width="28" height="24" rx="3" /><path d="M14 25h4" /></>}
  </svg>;
}

export function DeviceHingeControls({ angle, folding, onFoldingChange, onChange, onPose }: {
  onPose: (pose: string) => void;
  angle: number; folding: boolean; onFoldingChange: (enabled: boolean) => void; onChange: (angle: number) => void;
}) {
  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => bindAltHeld(window, setAltHeld), []);
  return <div role="group" aria-label="Fold pose" title="Hold Alt (Option) for precise hinge control" className="flex items-center">
    <SimulatorToolbar.Button aria-label="Fold gesture mode" aria-pressed={folding}
      title="Fold gesture mode: pinch or drag to open and close"
      onClick={() => onFoldingChange(!folding)}
      style={folding ? pressedStyle : undefined}>
      <svg width="18" height="18" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="17" height="17" rx="3" />
        <path d="M3 14V8a5 5 0 0 1 5-5h5m-4-3 4 3-4 3M31 20v6a5 5 0 0 1-5 5h-5m4-3-4 3 4 3" />
      </svg>
    </SimulatorToolbar.Button>
    <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-white/15" />
    {altHeld ? <div className="flex w-36 items-center gap-1.5 px-1">
      <input aria-label="Hinge angle" aria-valuetext={`${angle.toFixed(1)} degrees`} type="range"
        min="0" max="180" step="0.1" value={angle}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-7 min-w-0 flex-1 cursor-ew-resize accent-[#0a84ff]" />
      <output className="w-11 text-right text-[11px] tabular-nums text-white/90">{angle.toFixed(1)}°</output>
    </div> : poses.map((pose) => {
      const selected = Math.abs(angle - pose.angle) < 0.6;
      return <SimulatorToolbar.Button key={pose.id}
        aria-label={`${pose.label} pose`} title={`${pose.label} · ${pose.angle}° · Hold Alt for fine control`}
        aria-pressed={selected}
        onClick={() => onPose(pose.id)}
        style={selected ? pressedStyle : undefined}>
        <PoseIcon pose={pose.id} />
      </SimulatorToolbar.Button>;
    })}
  </div>;
}
