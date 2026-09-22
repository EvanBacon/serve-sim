import { useMjpegStream } from "../hooks/use-mjpeg-stream";
import { useEffect, useRef, useState } from "react";
import type { DuoProjection } from "../../duo-renderer";
import { pointOnDuoScreen } from "../utils/duo-projection";

import { duoHardwarePositions, duoPoseKey } from "../utils/duo-controls-position";
import { duoHardwareKeys, HardwareKey } from "./duo-hardware-controls";

import type { StreamConfig } from "../types";
import { beginDuoTouch, moveDuoTouch, type DuoTouchPoint } from "../utils/duo-home-gesture";
type Point = DuoTouchPoint;
export function DuoThreeDView({ url, projection, onTouch, onMultiTouch, onError, onHardwarePress, onStreamingChange, screenConfig, children }: {
  children?: React.ReactNode;
  screenConfig: StreamConfig;
  onError?: () => void;
  onStreamingChange: (streaming: boolean) => void;
  onHardwarePress: React.ComponentProps<typeof HardwareKey>["onPress"];
  url: string; projection: DuoProjection | null;
  onTouch: (event: { type: string; x: number; y: number; edge?: number }) => void;
  onMultiTouch: (event: { type: string; x1: number; y1: number; x2: number; y2: number }) => void;
}) {
  const hardwarePositions = duoHardwarePositions(projection);
  const poseKey = duoPoseKey(projection);
  const [settledPose, setSettledPose] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettledPose(poseKey), 220);
    return () => clearTimeout(timer);
  }, [poseKey]);
  const controlsVisible = projection != null && settledPose === poseKey;
  const image = useRef<HTMLImageElement | null>(null);
  const { subscribeFrame } = useMjpegStream(url, onStreamingChange);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    let currentUrl: string | null = null;
    const watchdog = setTimeout(() => errorHandler.current?.(), 12000);
    const unsubscribe = subscribeFrame((blobUrl) => {
      clearTimeout(watchdog);
      const previous = currentUrl;
      currentUrl = blobUrl;
      if (image.current) image.current.src = blobUrl;
      if (previous) URL.revokeObjectURL(previous);
    });
    return () => {
      clearTimeout(watchdog);
      unsubscribe();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [subscribeFrame, url]);
  const points = useRef(new Map<number, Point>());
  useEffect(() => () => {
    const [a, b] = [...points.current.values()];
    if (a && b) onMultiTouch({ type: "end", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    else if (a) onTouch({ type: "end", ...a });
    points.current.clear();
  }, [onTouch, onMultiTouch]);
  const pair = () => {
    const [a,b] = [...points.current.values()];
    return a && b ? { x1: a.x, y1: a.y, x2: b.x, y2: b.y } : null;
  };
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return pointOnDuoScreen(projection, (event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
  };
  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    const previous = points.current.get(event.pointerId);
    if (!previous) return;
    const two = pair();
    if (two) { onMultiTouch({ type: "end", ...two }); points.current.clear(); }
    else { onTouch({ type: "end", ...previous }); points.current.delete(event.pointerId); }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div aria-label="Interactive 3D iPhone Duo" className="relative w-full h-full bg-transparent select-none" style={{ touchAction: "none", cursor: "pointer", userSelect: "none", WebkitUserSelect: "none" }}
    onPointerDown={(event) => {
      if (event.button !== 0 || points.current.size >= 2) return;
      const hit = point(event);
      if (!hit) return;
      const raw = beginDuoTouch(hit, screenConfig);
      event.preventDefault();
      const first = [...points.current.values()][0];
      if (first) onTouch({ type: "end", ...first });
      points.current.set(event.pointerId, raw);
      event.currentTarget.setPointerCapture(event.pointerId);
      const two = pair();
      if (two) onMultiTouch({ type: "begin", ...two });
      else onTouch({ type: "begin", ...raw });
    }}
    onPointerMove={(event) => {
      if (!points.current.has(event.pointerId)) return;
      const hit = point(event);
      if (!hit) return;
      const raw = moveDuoTouch(points.current.get(event.pointerId)!, hit);
      points.current.set(event.pointerId, raw);
      const two = pair();
      if (two) onMultiTouch({ type: "move", ...two }); else onTouch({ type: "move", ...raw });
    }} onPointerUp={end} onPointerCancel={end}>
    <img ref={image} onError={onError} alt="Live 3D iPhone Duo" draggable={false} className="block w-full h-full object-contain pointer-events-none bg-transparent" />
    {children}
    {controlsVisible && hardwarePositions.map((position) => <div
      key={position.key}
      className="duo-hardware-anchor"
      style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%`, transform: `rotate(${position.angle}deg)` }}
    >
      <div className="duo-hardware-region">
        <HardwareKey value={duoHardwareKeys[position.key]!} iconRotation={-position.angle} onPress={onHardwarePress} />
      </div>
    </div>)}
  </div>;
}
