import { useEffect, useState, type CSSProperties } from "react";
import { SimulatorToolbar } from "../simulator";
import { bindAltHeld } from "../utils/bind-alt-held";
import type { SimulatorOrientation } from "../types";
import { DeviceGlyph } from "./device-glyph";

const poses = [
  { id: "closed", label: "Folded", angle: 0 },
  { id: "book", label: "Semi-folded", angle: 130 },
  { id: "open", label: "Fully open", angle: 180 },
] as const;

const pressedStyle: CSSProperties = { color: "#0a84ff" };

function PoseIcon({ pose }: { pose: string }) {
  if (pose === "closed") {
    return <span aria-hidden="true" className="contents"><DeviceGlyph type="iphone" duo size={18} /></span>;
  }
  if (pose === "book") {
    return <svg width="18" height="18" viewBox="0 0 102 102" fill="none" aria-hidden="true">
      <path d="M85.7422 14.5713C89.7595 13.779 93.5 16.8536 93.5 20.9482V82.5713C93.4998 86.5396 89.9745 89.5816 86.0488 89.001L52.1826 83.9922C51.0669 83.8272 49.9331 83.8272 48.8174 83.9922L14.9512 89.001C11.0255 89.5816 7.50021 86.5396 7.5 82.5713V20.9482C7.5 16.8536 11.2405 13.779 15.2578 14.5713L48.2754 21.082C49.7444 21.3717 51.2556 21.3717 52.7246 21.082L85.7422 14.5713Z" stroke="currentColor" strokeWidth="5" />
    </svg>;
  }
  return <svg width="18" height="18" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="4" width="28" height="24" rx="3" /><path d="M14 25h4" />
  </svg>;
}

export function DeviceHingeControls({ angle, onChange, onPose, orientation = "portrait" }: {
  orientation?: SimulatorOrientation;
  onPose: (pose: string) => void;
  angle: number; onChange: (angle: number) => void;
}) {
  const targetRotation = { portrait: 0, landscape_left: 90, portrait_upside_down: 180, landscape_right: -90 }[orientation];
  const [iconRotation, setIconRotation] = useState(targetRotation);
  useEffect(() => {
    setIconRotation((previous) => previous + ((targetRotation - previous + 540) % 360 + 360) % 360 - 180);
  }, [targetRotation]);
  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => bindAltHeld(window, setAltHeld), []);
  return <div role="group" aria-label="Fold pose" className="flex items-center">
    {altHeld ? <div className="flex w-36 items-center gap-1.5 px-1">
      <input aria-label="Hinge angle" aria-valuetext={`${angle.toFixed(1)} degrees`} type="range"
        min="0" max="180" step="0.1" value={angle}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-7 min-w-0 flex-1 cursor-ew-resize accent-[#0a84ff]" />
      <output className="w-11 text-right text-[11px] tabular-nums text-white/90">{angle.toFixed(1)}°</output>
    </div> : poses.map((pose) => {
      const selected = Math.abs(angle - pose.angle) < 0.6;
      return <SimulatorToolbar.Button key={pose.id}
        aria-label={`${pose.label} pose`} title={`${pose.label} · ${pose.angle}°`}
        aria-pressed={selected}
        onClick={() => onPose(pose.id)}
        style={selected ? pressedStyle : undefined}>
        <span className="inline-flex items-center justify-center motion-reduce:transition-none" style={{ transform: `rotate(${iconRotation}deg)`, transition: "transform 300ms ease-in-out" }}>
          <PoseIcon pose={pose.id} />
        </span>
      </SimulatorToolbar.Button>;
    })}
  </div>;
}
