import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  SIMULATOR_RESIZE_MIN_WIDTH,
  clampSimulatorFrameWidth,
  getSimulatorFrameMaxWidth,
} from "../utils/simulator-resize";

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
  const [frameWidth, setFrameWidth] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [handleHovered, setHandleHovered] = useState(false);
  const resizeStartRef = useRef<{ pointerId: number; startX: number; startY: number; startWidth: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const maxWidth = getSimulatorFrameMaxWidth(defaultWidth, viewportWidth, viewportHeight, aspectRatio);
  const width = clampSimulatorFrameWidth(
    frameWidth ?? defaultWidth,
    defaultWidth,
    viewportWidth,
    viewportHeight,
    aspectRatio,
  );

  useEffect(() => {
    if (frameWidth == null) return;
    const next = clampSimulatorFrameWidth(
      frameWidth,
      defaultWidth,
      viewportWidth,
      viewportHeight,
      aspectRatio,
    );
    if (next !== frameWidth) setFrameWidth(next);
  }, [aspectRatio, defaultWidth, frameWidth, viewportHeight, viewportWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const previousWebkitUserSelect = document.body.style.webkitUserSelect;
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.body.style.webkitUserSelect = previousWebkitUserSelect;
    };
  }, [isResizing]);

  const scheduleFrameWidth = useCallback((nextWidth: number) => {
    const clampedWidth = clampSimulatorFrameWidth(
      nextWidth,
      defaultWidth,
      viewportWidth,
      viewportHeight,
      aspectRatio,
    );
    if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      setFrameWidth(clampedWidth);
    });
  }, [aspectRatio, defaultWidth, viewportHeight, viewportWidth]);

  const stopResize = useCallback(() => {
    const pointerId = resizeStartRef.current?.pointerId;
    resizeStartRef.current = null;
    if (pointerId != null && pointerId >= 0) {
      const handle = handleRef.current;
      if (handle?.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
    }
    if (resizeFrameRef.current != null) {
      cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    setIsResizing(false);
  }, []);

  useEffect(() => {
    return () => stopResize();
  }, [stopResize]);

  useEffect(() => {
    if (!isResizing) return;

    const stop = () => stopResize();
    const stopWhenHidden = () => {
      if (document.visibilityState === "hidden") stopResize();
    };

    window.addEventListener("blur", stop);
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    document.addEventListener("visibilitychange", stopWhenHidden);

    return () => {
      window.removeEventListener("blur", stop);
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      document.removeEventListener("visibilitychange", stopWhenHidden);
    };
  }, [isResizing, stopResize]);

  const onPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    stopResize();
  }, [stopResize]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStartRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: width,
    };
    onStart();
    setIsResizing(true);
  }, [onStart, width]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (event.buttons !== 1) {
      stopResize();
      return;
    }

    const deltaX = event.clientX - start.startX;
    const deltaY = (event.clientY - start.startY) * aspectRatio;
    const nextWidth = start.startWidth + (Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY);
    scheduleFrameWidth(nextWidth);
  }, [aspectRatio, scheduleFrameWidth, stopResize]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
    if (direction === 0) return;
    event.preventDefault();
    const step = event.shiftKey ? 80 : 24;
    setFrameWidth(clampSimulatorFrameWidth(
      width + (direction * step),
      defaultWidth,
      viewportWidth,
      viewportHeight,
      aspectRatio,
    ));
  }, [aspectRatio, defaultWidth, viewportHeight, viewportWidth, width]);

  return {
    handleRef,
    width,
    maxWidth,
    minWidth: SIMULATOR_RESIZE_MIN_WIDTH,
    isResizing,
    handleActive: handleHovered || isResizing,
    setHandleHovered,
    onPointerDown,
    onPointerMove,
    onPointerEnd,
    onKeyDown,
  };
}
