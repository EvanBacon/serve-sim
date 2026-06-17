import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

export function resistedGrabberOffset({
  clientY,
  top,
  height,
  grabberHeight = 28,
  edgeMargin = 16,
}: {
  clientY: number;
  top: number;
  height: number;
  grabberHeight?: number;
  edgeMargin?: number;
}) {
  const centerY = top + height / 2;
  const maxTravel = Math.max(0, height / 2 - grabberHeight / 2 - edgeMargin);
  const delta = clientY - centerY;
  const magnitude = Math.abs(delta);
  const resisted = magnitude / (1 + magnitude / Math.max(1, maxTravel));
  return Math.sign(delta) * Math.min(maxTravel, resisted);
}

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
  const [grabberOffset, setGrabberOffset] = useState(0);
  const activeRef = useRef(false);
  const hoverRef = useRef(false);
  const hot = hover || active;
  const updateGrabberOffset = useCallback((target: HTMLDivElement, clientY: number) => {
    const rect = target.getBoundingClientRect();
    setGrabberOffset(resistedGrabberOffset({ clientY, top: rect.top, height: rect.height }));
  }, []);

  useEffect(() => {
    if (!visible) setGrabberOffset(0);
  }, [visible]);

  // A right-edge panel sits at right:12 — its draggable (left) border is at
  // right:(12 + panelWidth - 1). The flush left sidebar sits at left:0, so its
  // draggable right border is at left:(panelWidth - 1). Center the 16px hit
  // target on whichever border is interior.
  const handleOffset = (side === "left" ? 0 : 12) + panelWidth - 9;
  const edgeClass = side === "left" ? "top-0 bottom-0" : "top-3 bottom-3";
  const grabberTop = `calc(50% + ${grabberOffset}px)`;
  const returnTransition = "top 0.22s cubic-bezier(0.22, 1, 0.36, 1)";

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-hidden={!visible}
      onPointerDown={(e) => {
        activeRef.current = true;
        setActive(true);
        updateGrabberOffset(e.currentTarget, e.clientY);
        onPointerDown(e);
      }}
      onPointerMove={(e) => updateGrabberOffset(e.currentTarget, e.clientY)}
      onPointerUp={(e) => {
        activeRef.current = false;
        setActive(false);
        if (hoverRef.current) updateGrabberOffset(e.currentTarget, e.clientY);
        else setGrabberOffset(0);
      }}
      onPointerCancel={() => {
        activeRef.current = false;
        setActive(false);
        setGrabberOffset(0);
      }}
      onPointerEnter={(e) => {
        hoverRef.current = true;
        setHover(true);
        updateGrabberOffset(e.currentTarget, e.clientY);
      }}
      onPointerLeave={() => {
        hoverRef.current = false;
        setHover(false);
        if (!activeRef.current) setGrabberOffset(0);
      }}
      className={`fixed ${edgeClass} w-4 z-36 cursor-col-resize touch-none transition-opacity duration-200 ${visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
      style={side === "left" ? { left: handleOffset } : { right: handleOffset }}
    >
      {/* Subtle hairline accent that brightens the panel's existing border
          while the edge is hot. Tapers at top/bottom. */}
      <div
        className={`absolute top-0 bottom-0 left-1/2 w-px overflow-hidden pointer-events-none transition-opacity duration-150 ${hot ? "opacity-100" : "opacity-0"}`}
        style={{
          transform: "translateX(-0.5px)",
        }}
      >
        <div
          className="absolute left-0 h-44 w-px -translate-y-1/2 pointer-events-none"
          style={{
            top: grabberTop,
            transition: hot ? "none" : returnTransition,
            background:
              "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.12) 28%, rgba(255,255,255,0.34) 50%, rgba(255,255,255,0.12) 72%, rgba(255,255,255,0) 100%)",
          }}
        />
      </div>
      {/* Centered pill grabber, straddling the panel's left border. */}
      <div
        className={`absolute top-1/2 left-1/2 w-1 h-7 rounded-xs -translate-x-1/2 -translate-y-1/2 z-1 pointer-events-none ${hot ? "opacity-100" : "opacity-0"} ${active ? "bg-[#9a9a9e]" : "bg-[#6e6e72]"}`}
        style={{
          top: grabberTop,
          transition: hot
            ? "opacity 0.15s ease, background 0.15s ease"
            : `opacity 0.15s ease, background 0.15s ease, ${returnTransition}`,
        }}
      />
    </div>
  );
}
