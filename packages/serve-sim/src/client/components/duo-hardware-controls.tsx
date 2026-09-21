import { useCallback, useEffect, useRef } from "react";
import { Camera, Lock, Volume1, Volume2 } from "lucide-react";
import { SimulatorToolbar } from "../simulator";

const keys = [
  { name: "Volume down", page: 12, usage: 234, Icon: Volume1 },
  { name: "Volume up", page: 12, usage: 233, Icon: Volume2 },
  { name: "Power", page: 12, usage: 48, Icon: Lock },
  { name: "Camera control", page: 65280, usage: 102, Icon: Camera },
] as const;
type Key = (typeof keys)[number];
type Press = (key: Key, phase: "down" | "up" | "press") => void;

function HardwareKey({ value, onPress }: { value: Key; onPress: Press }) {
  const held = useRef(false);
  const release = useCallback(() => { if (held.current) { held.current = false; onPress(value, "up"); } }, [value, onPress]);
  useEffect(() => release, [release]);
  return <SimulatorToolbar.Button aria-label={value.name} title={`${value.name} (hold for long press)`}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      held.current = true;
      onPress(value, "down");
    }} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
    onClick={(event) => { if (event.detail === 0) onPress(value, "press"); }}>
    <value.Icon size={18} strokeWidth={2} aria-hidden="true" />
  </SimulatorToolbar.Button>;
}

export function DuoHardwareControls({ onPress }: { onPress: Press }) {
  return <div role="group" aria-label="Duo hardware buttons" className="flex items-center">
    {keys.map((key) => <HardwareKey key={key.name} value={key} onPress={onPress} />)}
  </div>;
}
