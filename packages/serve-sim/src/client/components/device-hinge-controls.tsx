import { useEffect, useState } from "react";
import { bindAltHeld } from "../utils/bind-alt-held";

const poses = [
  { id: "closed", label: "Folded", angle: 0 },
  { id: "book", label: "Cracked open", angle: 130 },
  { id: "open", label: "Fully open", angle: 180 },
] as const;

function PoseIcon({ pose }: { pose: string }) {
  return <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
  return <div className="flex flex-col items-center gap-2">
    <div role="group" aria-label="Fold pose" title="Hold Alt (Option) for precise hinge control"
      className="flex h-16 items-center rounded-full border border-white/20 bg-gradient-to-b from-[#504f4e] to-[#41403f] px-2 shadow-[inset_0_1px_1px_#ffffff20,0_2px_5px_#00000030]">
      <button type="button" aria-label="Fold gesture mode" aria-pressed={folding}
        title="Fold gesture mode: pinch or drag to open and close"
        onClick={() => onFoldingChange(!folding)}
        className="flex size-12 items-center justify-center rounded-full text-white hover:bg-white/10 aria-pressed:text-[#0a84ff] focus-visible:outline-2 focus-visible:outline-blue-400">
        <svg width="34" height="34" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="17" height="17" rx="3" />
          <path d="M3 14V8a5 5 0 0 1 5-5h5m-4-3 4 3-4 3M31 20v6a5 5 0 0 1-5 5h-5m4-3-4 3 4 3" />
        </svg>
      </button>
      <div className="mx-2 h-8 w-px bg-white/20" />
      <div className="flex w-[192px] items-center justify-center">
        {altHeld ? <div className="flex w-full items-center gap-2 px-2">
          <input aria-label="Hinge angle" aria-valuetext={`${angle.toFixed(1)} degrees`} type="range"
            min="0" max="180" step="0.1" value={angle}
            onChange={(event) => onChange(Number(event.currentTarget.value))}
            className="h-8 min-w-0 flex-1 cursor-ew-resize accent-[#0a84ff]" />
          <output className="w-12 text-right text-xs tabular-nums text-white">{angle.toFixed(1)}°</output>
        </div> : poses.map((pose) => <button key={pose.id} type="button"
          aria-label={`${pose.label} pose`} title={`${pose.label} · ${pose.angle}° · Hold Alt for fine control`}
          aria-pressed={Math.abs(angle - pose.angle) < 0.6}
          onClick={() => onPose(pose.id)}
          className="flex h-12 w-16 items-center justify-center rounded-full text-white hover:bg-white/10 aria-pressed:text-[#0a84ff] focus-visible:outline-2 focus-visible:outline-blue-400">
          <PoseIcon pose={pose.id} />
        </button>)}
      </div>
    </div>
    <span className="text-[11px] text-[#aaa]">{folding ? "Pinch or drag to fold" : "Hold ⌥ Alt for precise hinge control"}</span>
  </div>;
}
