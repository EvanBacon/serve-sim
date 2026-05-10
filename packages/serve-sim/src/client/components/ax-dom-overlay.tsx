import {
  useAxSelectionContext,
  useAxSnapshotContext,
} from "../hooks/use-ax-snapshot";
import { axElementKey } from "../utils/ax";
import { AxTarget } from "./ax-target";

export function AxDomOverlay() {
  const { snapshot } = useAxSnapshotContext();
  const {
    highlightedKey,
    selectedKey,
    setHighlightedKey,
    setSelectedKey,
  } = useAxSelectionContext();

  if (!snapshot?.screen.width || !snapshot?.screen.height) return null;

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
