import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { SimulatorToolbar } from "../simulator";
import { DuoHardwareControls } from "./duo-hardware-controls";

type Press = Parameters<typeof DuoHardwareControls>[0]["onPress"];

/** Keeps volume controls in the toolbar; power and camera sit beside the device. */
export function DuoHardwareMenu({ onPress }: { onPress: Press }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative" data-duo-hardware-menu>
      <SimulatorToolbar.Button
        aria-label="More Duo controls"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Volume controls"
        onClick={() => setOpen((value) => !value)}
        style={
          open
            ? { color: "rgba(255,255,255,0.95)", background: "rgba(255,255,255,0.12)" }
            : undefined
        }
      >
        <MoreHorizontal size={18} strokeWidth={2} aria-hidden="true" />
      </SimulatorToolbar.Button>
      {open && (
        <div
          role="menu"
          aria-label="Duo hardware buttons"
          className="absolute bottom-[calc(100%+8px)] right-0 z-30 flex items-center gap-0.5 rounded-[14px] border border-white/10 bg-[rgba(28,28,30,0.92)] p-1.5 shadow-[0_10px_28px_rgba(0,0,0,0.45)] backdrop-blur-[14px]"
        >
          <DuoHardwareControls onPress={onPress} />
        </div>
      )}
    </div>
  );
}
