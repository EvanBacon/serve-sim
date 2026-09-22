import {
  useAxSelectionContext,
  useAxSnapshotContext,
} from "../hooks/use-ax-snapshot";
import type { DuoProjection } from "../../duo-renderer";
import type { StreamConfig } from "../types";
import { duoAxFrame } from "../utils/duo-ax-frame";
import { projectDuoRect } from "../utils/duo-projection";
import { axElementKey } from "../utils/ax";
import { AxTarget } from "./ax-target";

export function AxDomOverlay({ projection, screenConfig }: { projection?: DuoProjection | null; screenConfig?: StreamConfig } = {}) {
  const { snapshot } = useAxSnapshotContext();
  const {
    highlightedKey,
    selectedKey,
    setHighlightedKey,
    setSelectedKey,
  } = useAxSelectionContext();

  if (!snapshot?.screen.width || !snapshot?.screen.height) return null;

  if (projection && screenConfig) {
    return <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 w-full h-full z-10 pointer-events-none">
      {snapshot.elements.map((element) => {
        const key = axElementKey(element), f = element.frame;
        const polygons = projectDuoRect(projection, duoAxFrame(f, screenConfig));
        const color = key === selectedKey ? "#60a5fa" : key === highlightedKey ? "#fbbf24" : "#34d399";
        return polygons.map((polygon, index) => <polygon key={`${key}:${index}`}
          points={polygon.map((p) => p.join(",")).join(" ")} fill={color} fillOpacity={0.15} stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke"
          className="pointer-events-auto cursor-pointer" data-ax-key={key} role="button" tabIndex={0} aria-label={element.label || element.role || "AX element"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setSelectedKey(key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(key); } }}
          onMouseEnter={() => setHighlightedKey(key)} onMouseLeave={() => setHighlightedKey(null)}
        ><title>{element.label || element.role}</title></polygon>);
      })}
    </svg>;
  }

  return (
    <div className="absolute inset-0 z-10 overflow-hidden pointer-events-none">
      {snapshot.elements.map((element, index) => {
        const key = axElementKey(element);
        return (
          <AxTarget
            key={key}
            element={element}
            index={index}
            screen={snapshot.screen}
            highlighted={key === highlightedKey}
            selected={key === selectedKey}
            onHighlight={setHighlightedKey}
            onSelect={setSelectedKey}
          />
        );
      })}
    </div>
  );
}
