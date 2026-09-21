import { devicePosePresets } from "../../device-pose";

export function DeviceHingeControls({ angle, folding, onFoldingChange, onChange, onPose }: {
  onPose: (pose: string) => void;
  angle: number; folding: boolean; onFoldingChange: (enabled: boolean) => void; onChange: (angle: number) => void;
}) {
  return <div role="group" aria-label="Fold pose" className="flex flex-col gap-2 rounded-2xl bg-panel-bg p-3 w-full max-w-[460px] text-xs">
    <div className="flex justify-center gap-1">
      {devicePosePresets().map((pose) => <button key={pose.id} type="button"
        aria-label={`${pose.label} pose`} aria-pressed={Math.abs(angle - pose.hingeDegrees) < 1}
        onClick={() => onPose(pose.id)}
        className="px-2 py-1 rounded-lg hover:bg-white/10 aria-pressed:bg-white/15 text-white">
        {pose.label}
      </button>)}
    </div>
    <div className="flex items-center gap-2">
      <span>Hinge</span>
      <input aria-label="Hinge angle" type="range" min="0" max="180" step="1" value={angle}
        onChange={(event) => onChange(Number(event.currentTarget.value))} className="min-w-0 flex-1 accent-blue-500" />
      <output className="tabular-nums w-9 text-right">{Math.round(angle)}°</output>
    </div>
    <button type="button" aria-pressed={folding} onClick={() => onFoldingChange(!folding)}
      className="rounded-lg px-2 py-1 text-white hover:bg-white/10 aria-pressed:bg-blue-600">
      {folding ? "Fold mode · pinch or drag to open / close" : "Interact with app · switch to fold mode"}
    </button>
  </div>;
}
