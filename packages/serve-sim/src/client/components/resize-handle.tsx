import { useState, type PointerEvent as ReactPointerEvent } from "react";

// Rendered as a fixed-positioned sibling of the panel, so the grabber can
// straddle the panel's left border without being clipped by overflow:hidden.
// The panel's own 1px border serves as the "line" — we just brighten it and
// add a centered pill on hover/drag.
export function ResizeHandle({
  panelWidth,
  visible,
  onPointerDown,
  ariaLabel,
  side = "right",
}: {
  panelWidth: number;
  visible: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  ariaLabel: string;
  side?: "left" | "right";
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const hot = hover || active;

  // A right-edge panel sits at right:12 — its draggable (left) border is at
  // right:(12 + panelWidth - 1). The flush left sidebar sits at left:0, so its
  // draggable right border is at left:(panelWidth - 1). Center the 16px hit
  // target on whichever border is interior.
  const handleOffset = (side === "left" ? 0 : 12) + panelWidth - 9;
  const edgeClass = side === "left" ? "top-0 bottom-0" : "top-3 bottom-3";
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-hidden={!visible}
      onPointerDown={(e) => {
        setActive(true);
        onPointerDown(e);
      }}
      onPointerUp={() => setActive(false)}
      onPointerCancel={() => setActive(false)}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className={`fixed ${edgeClass} w-4 z-36 cursor-col-resize touch-none transition-opacity duration-200 ${visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
      style={side === "left" ? { left: handleOffset } : { right: handleOffset }}
    >
      {/* Subtle hairline accent that brightens the panel's existing border
          while the edge is hot. Tapers at top/bottom. */}
      <div
        className={`absolute top-0 bottom-0 left-1/2 w-px pointer-events-none transition-opacity duration-150 ${hot ? "opacity-100" : "opacity-0"}`}
        style={{
          transform: "translateX(-0.5px)",
          background:
            "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.28) 30%, rgba(255,255,255,0.28) 70%, rgba(255,255,255,0) 100%)",
        }}
      />
      {/* Centered pill grabber, straddling the panel's left border. */}
      <div
        className={`absolute top-1/2 left-1/2 w-1 h-7 rounded-xs -translate-x-1/2 -translate-y-1/2 z-1 pointer-events-none [transition:opacity_0.15s_ease,background_0.15s_ease] ${hot ? "opacity-100" : "opacity-0"} ${active ? "bg-[#9a9a9e]" : "bg-[#6e6e72]"}`}
      />
    </div>
  );
}
