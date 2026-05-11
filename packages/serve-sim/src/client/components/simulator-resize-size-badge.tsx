// Floating W × H readout that fades in next to the resize handle while a drag or
// release-tween is in flight. Lives inside the simulator container so it tracks
// the frame even when the page is shifted by an open panel.
export function SimulatorResizeSizeBadge({
  width,
  height,
  visible,
}: {
  width: number;
  height: number;
  visible: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className="absolute right-3 bottom-3 z-20 pointer-events-none select-none rounded-lg px-2.5 py-1 text-[11.5px] font-mono leading-none tracking-wide text-white/95 bg-[rgba(20,22,28,0.78)] shadow-[0_1px_2px_rgba(0,0,0,0.18),0_6px_18px_rgba(0,0,0,0.28),inset_0_0_0_1px_rgba(255,255,255,0.06)] backdrop-blur-md backdrop-saturate-150 whitespace-nowrap"
      style={{
        opacity: visible ? 1 : 0,
        transform: `translateY(${visible ? 0 : 4}px) scale(${visible ? 1 : 0.96})`,
        transformOrigin: "100% 100%",
        transition:
          "opacity 180ms cubic-bezier(0.4, 0, 0.2, 1), transform 220ms cubic-bezier(0.2, 0.82, 0.22, 1)",
      }}
    >
      {Math.round(width)} <span className="opacity-60 mx-0.5">×</span> {Math.round(height)}
    </div>
  );
}
