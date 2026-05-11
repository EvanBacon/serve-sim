import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";
import {
  SIMULATOR_RESIZE_DETENT_RADIUS,
  SIMULATOR_RESIZE_MIN_WIDTH,
  SIMULATOR_RESIZE_MOMENTUM_S,
  SIMULATOR_RESIZE_PERSIST_DEBOUNCE_MS,
  SIMULATOR_RESIZE_SCALE_STORAGE_KEY,
  SIMULATOR_RESIZE_SPRING_DAMPING,
  SIMULATOR_RESIZE_SPRING_STIFFNESS,
  SIMULATOR_RESIZE_VELOCITY_HISTORY_MS,
  clampSimulatorFrameWidth,
  estimateReleaseVelocity,
  getSimulatorFrameMaxWidth,
  roundToDevicePixel,
  rubberBandResistance,
  snapToDetent,
  springTo,
} from "../utils/simulator-resize";

type DragStart = {
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
};

type Sample = { t: number; x: number };

export function useSimulatorResize({
  defaultWidth,
  viewportWidth,
  viewportHeight,
  aspectRatio,
  onStart,
}: {
  defaultWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  aspectRatio: number;
  onStart: () => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [isResizing, setIsResizing] = useState(false);
  const [isInertia, setIsInertia] = useState(false);
  const [handleHovered, setHandleHovered] = useState(false);
  const dragStartRef = useRef<DragStart | null>(null);
  const samplesRef = useRef<Sample[]>([]);
  const rafRef = useRef<number | null>(null);
  const tweenCancelRef = useRef<(() => void) | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWidthRef = useRef<number | null>(null);
  const handleRef = useRef<SVGSVGElement | null>(null);

  const initialWidth = useMemo(() => {
    if (typeof window === "undefined") return defaultWidth;
    try {
      const raw = window.localStorage.getItem(SIMULATOR_RESIZE_SCALE_STORAGE_KEY);
      const scale = raw != null ? Number(raw) : NaN;
      return Number.isFinite(scale) ? defaultWidth * scale : defaultWidth;
    } catch {
      return defaultWidth;
    }
  }, [defaultWidth]);
  const [frameWidth, setFrameWidth] = useState<number | null>(initialWidth);

  const maxWidth = getSimulatorFrameMaxWidth(defaultWidth, viewportWidth, viewportHeight, aspectRatio);
  const minWidth = Math.min(SIMULATOR_RESIZE_MIN_WIDTH, maxWidth);

  // `width` is the displayed width (may include rubber-band overshoot during drag/inertia).
  // `committedWidth` is the bound-clamped value used for aria, keyboard math, and persistence.
  const width = frameWidth ?? defaultWidth;
  const committedWidth = clampSimulatorFrameWidth(
    width,
    defaultWidth,
    viewportWidth,
    viewportHeight,
    aspectRatio,
  );

  const writeWidth = useCallback((next: number) => {
    const rounded = roundToDevicePixel(next);
    lastWidthRef.current = rounded;
    setFrameWidth(rounded);
  }, []);

  const persistNow = useCallback(
    (value: number) => {
      if (typeof window === "undefined" || defaultWidth <= 0) return;
      const clamped = clampSimulatorFrameWidth(value, defaultWidth, viewportWidth, viewportHeight, aspectRatio);
      try {
        window.localStorage.setItem(SIMULATOR_RESIZE_SCALE_STORAGE_KEY, String(clamped / defaultWidth));
      } catch {}
    },
    [aspectRatio, defaultWidth, viewportHeight, viewportWidth],
  );

  const schedulePersist = useCallback(
    (value: number) => {
      if (persistTimerRef.current != null) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        persistNow(value);
      }, SIMULATOR_RESIZE_PERSIST_DEBOUNCE_MS);
    },
    [persistNow],
  );

  // Re-clamp on viewport / device change, but never while a drag or inertia is in flight —
  // that would fight rubber-band overshoot.
  useEffect(() => {
    if (isResizing || isInertia) return;
    const current = lastWidthRef.current;
    if (current == null) return;
    const next = clampSimulatorFrameWidth(current, defaultWidth, viewportWidth, viewportHeight, aspectRatio);
    if (next !== current) writeWidth(next);
  }, [aspectRatio, defaultWidth, isInertia, isResizing, viewportHeight, viewportWidth, writeWidth]);

  useEffect(() => {
    writeWidth(initialWidth);
  }, [initialWidth, writeWidth]);

  useEffect(() => {
    if (!isResizing && !isInertia) return;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    const prevWebkitUserSelect = document.body.style.webkitUserSelect;
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      document.body.style.webkitUserSelect = prevWebkitUserSelect;
    };
  }, [isResizing, isInertia]);

  // The debounced persist would otherwise be lost if the tab closes mid-interaction.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => {
      const w = lastWidthRef.current;
      if (w == null) return;
      if (persistTimerRef.current != null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      persistNow(w);
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [persistNow]);

  const displayWidthFromRaw = useCallback(
    (raw: number): number => {
      if (raw > maxWidth) return maxWidth + rubberBandResistance(raw - maxWidth, maxWidth);
      if (raw < minWidth) return minWidth - rubberBandResistance(minWidth - raw, maxWidth);
      return raw;
    },
    [maxWidth, minWidth],
  );

  const cancelTween = useCallback(() => {
    if (tweenCancelRef.current) {
      tweenCancelRef.current();
      tweenCancelRef.current = null;
    }
    setIsInertia(false);
  }, []);

  const recordSample = useCallback((x: number) => {
    const t = performance.now();
    const buf = samplesRef.current;
    buf.push({ t, x });
    while (buf.length > 1 && t - buf[0]!.t > SIMULATOR_RESIZE_VELOCITY_HISTORY_MS) buf.shift();
  }, []);

  const scheduleMove = useCallback(
    (rawWidth: number) => {
      const display = displayWidthFromRaw(rawWidth);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        writeWidth(display);
        recordSample(display);
      });
    },
    [displayWidthFromRaw, recordSample, writeWidth],
  );

  const beginDrag = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      cancelTween();
      const startWidth = lastWidthRef.current ?? defaultWidth;
      dragStartRef.current = { pointerId, startX: clientX, startY: clientY, startWidth };
      samplesRef.current = [{ t: performance.now(), x: startWidth }];
      onStart();
      setIsResizing(true);
    },
    [cancelTween, defaultWidth, onStart],
  );

  const endDrag = useCallback(() => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (start && start.pointerId >= 0) {
      const handle = handleRef.current;
      if (handle?.hasPointerCapture(start.pointerId)) {
        handle.releasePointerCapture(start.pointerId);
      }
    }
    setIsResizing(false);

    const fromDisplay = lastWidthRef.current ?? defaultWidth;
    const velocity = estimateReleaseVelocity(samplesRef.current);
    samplesRef.current = [];

    const projected = clampSimulatorFrameWidth(
      fromDisplay + velocity * SIMULATOR_RESIZE_MOMENTUM_S,
      defaultWidth,
      viewportWidth,
      viewportHeight,
      aspectRatio,
    );
    const target = roundToDevicePixel(
      snapToDetent(projected, [defaultWidth], SIMULATOR_RESIZE_DETENT_RADIUS),
    );

    // Under reduced-motion, or when there's nothing meaningful to animate, snap directly.
    const trivial = Math.abs(fromDisplay - target) < 0.5 && Math.abs(velocity) < 8;
    if (reducedMotion || trivial) {
      writeWidth(target);
      schedulePersist(target);
      return;
    }

    setIsInertia(true);
    tweenCancelRef.current = springTo({
      from: fromDisplay,
      to: target,
      velocity,
      stiffness: SIMULATOR_RESIZE_SPRING_STIFFNESS,
      damping: SIMULATOR_RESIZE_SPRING_DAMPING,
      onUpdate: writeWidth,
      onComplete: () => {
        tweenCancelRef.current = null;
        setIsInertia(false);
        schedulePersist(target);
      },
    });
  }, [
    aspectRatio,
    defaultWidth,
    reducedMotion,
    schedulePersist,
    viewportHeight,
    viewportWidth,
    writeWidth,
  ]);

  useEffect(() => {
    return () => {
      cancelTween();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (persistTimerRef.current != null) {
        clearTimeout(persistTimerRef.current);
        if (lastWidthRef.current != null) persistNow(lastWidthRef.current);
      }
    };
  }, [cancelTween, persistNow]);

  useEffect(() => {
    if (!isResizing) return;
    const stop = () => endDrag();
    const stopWhenHidden = () => {
      if (document.visibilityState === "hidden") endDrag();
    };
    const updateFromPointer = (event: PointerEvent) => {
      const s = dragStartRef.current;
      if (!s || s.pointerId !== event.pointerId) return;
      event.preventDefault();
      scheduleMove(widthFromDelta(s, event.clientX, event.clientY, aspectRatio));
    };

    window.addEventListener("blur", stop);
    window.addEventListener("pointermove", updateFromPointer, { capture: true, passive: false });
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    document.addEventListener("visibilitychange", stopWhenHidden);

    return () => {
      window.removeEventListener("blur", stop);
      window.removeEventListener("pointermove", updateFromPointer, true);
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      document.removeEventListener("visibilitychange", stopWhenHidden);
    };
  }, [aspectRatio, endDrag, isResizing, scheduleMove]);

  const onPointerEnd = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const s = dragStartRef.current;
      if (!s || s.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      endDrag();
    },
    [endDrag],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      beginDrag(event.pointerId, event.clientX, event.clientY);
    },
    [beginDrag],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const s = dragStartRef.current;
      if (!s || s.pointerId !== event.pointerId) return;
      event.preventDefault();
      scheduleMove(widthFromDelta(s, event.clientX, event.clientY, aspectRatio));
    },
    [aspectRatio, scheduleMove],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const direction =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (direction === 0) return;
      event.preventDefault();
      cancelTween();
      const step = event.shiftKey ? 80 : 24;
      const next = roundToDevicePixel(
        clampSimulatorFrameWidth(
          committedWidth + direction * step,
          defaultWidth,
          viewportWidth,
          viewportHeight,
          aspectRatio,
        ),
      );
      writeWidth(next);
      schedulePersist(next);
    },
    [
      aspectRatio,
      cancelTween,
      committedWidth,
      defaultWidth,
      schedulePersist,
      viewportHeight,
      viewportWidth,
      writeWidth,
    ],
  );

  return {
    handleRef,
    width,
    committedWidth,
    minWidth,
    maxWidth,
    isResizing,
    isInertia,
    handleHovered,
    handleActive: handleHovered || isResizing || isInertia,
    setHandleHovered,
    onPointerDown,
    onPointerMove,
    onPointerEnd,
    onKeyDown,
  };
}

function widthFromDelta(
  start: { startX: number; startY: number; startWidth: number },
  clientX: number,
  clientY: number,
  aspectRatio: number,
) {
  const dx = clientX - start.startX;
  const dy = (clientY - start.startY) * aspectRatio;
  return start.startWidth + (Math.abs(dx) >= Math.abs(dy) ? dx : dy);
}
