import { useMjpegStream } from "../hooks/use-mjpeg-stream";
import { useEffect, useRef } from "react";
import type { DuoProjection } from "../../duo-renderer";
import { pointOnDuoScreen } from "../utils/duo-projection";

type Point = { x: number; y: number };
export function DuoThreeDView({ url, projection, onTouch, onMultiTouch, onError }: {
  onError?: () => void;
  url: string; projection: DuoProjection | null;
  onTouch: (event: { type: string; x: number; y: number; edge?: number }) => void;
  onMultiTouch: (event: { type: string; x1: number; y1: number; x2: number; y2: number }) => void;
}) {
  const image = useRef<HTMLImageElement | null>(null);
  const { subscribeFrame } = useMjpegStream(url);
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
  return <div aria-label="Interactive 3D iPhone Duo" className="w-full h-full bg-transparent" style={{ touchAction: "none", cursor: "pointer" }}
    onPointerDown={(event) => {
      if (event.button !== 0 || points.current.size >= 2) return;
      const raw = point(event);
      if (!raw) return;
      event.preventDefault();
      const first = [...points.current.values()][0];
      if (first) onTouch({ type: "end", ...first });
      points.current.set(event.pointerId, raw);
      event.currentTarget.setPointerCapture(event.pointerId);
      const two = pair();
      if (two) onMultiTouch({ type: "begin", ...two });
      else onTouch({ type: "begin", ...raw, ...(raw.y > .93 ? { edge: 3 } : {}) });
    }}
    onPointerMove={(event) => {
      if (!points.current.has(event.pointerId)) return;
      const raw = point(event);
      if (!raw) return;
      points.current.set(event.pointerId, raw);
      const two = pair();
      if (two) onMultiTouch({ type: "move", ...two }); else onTouch({ type: "move", ...raw });
    }} onPointerUp={end} onPointerCancel={end}>
    <img ref={image} onError={onError} alt="Live 3D iPhone Duo" draggable={false} className="block w-full h-full object-contain pointer-events-none bg-transparent" />
  </div>;
}
