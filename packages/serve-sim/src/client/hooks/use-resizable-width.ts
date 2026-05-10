import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";

// Persists a width to localStorage and exposes a pointer-driven resize handler.
// The panels live at the right edge, so dragging the handle leftwards grows
// the panel — the delta is `startX - clientX`.
export function useResizableWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number,
) {
  const clamp = useCallback(
    (w: number) => Math.max(min, Math.min(max, w)),
    [min, max],
  );
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return defaultWidth;
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw != null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clamp(parsed) : defaultWidth;
  });
  // Re-clamp if the viewport shrinks below the saved width.
  const effectiveMax = typeof window !== "undefined"
    ? Math.min(max, window.innerWidth - 32)
    : max;
  const effectiveWidth = Math.max(min, Math.min(effectiveMax, width));

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = effectiveWidth;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const next = clamp(startWidth + (startX - ev.clientX));
        setWidth(next);
      };
      const up = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId);
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        try {
          window.localStorage.setItem(storageKey, String(clamp(startWidth + (startX - ev.clientX))));
        } catch {}
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    },
    [clamp, effectiveWidth, storageKey],
  );

  return { width: effectiveWidth, onPointerDown };
}
