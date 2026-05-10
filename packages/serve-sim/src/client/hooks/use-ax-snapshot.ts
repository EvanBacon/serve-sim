import { createContext, useContext, useEffect, useState } from "react";
import type { AxSnapshot } from "../../ax-shared";
import { isAxeUnavailable } from "../utils/ax";

export function useAxSnapshot(endpoint?: string) {
  const [snapshot, setSnapshot] = useState<AxSnapshot | null>(null);
  const [status, setStatus] = useState("AX off");

  useEffect(() => {
    if (!endpoint) {
      setSnapshot(null);
      setStatus("AX off");
      return;
    }

    setSnapshot(null);
    setStatus("AX waiting");
    const source = new EventSource(endpoint);
    source.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as AxSnapshot;
        setSnapshot(next);
        setStatus(
          isAxeUnavailable(next)
            ? "AX unavailable"
            : `${next.elements.length} AX elements`,
        );
      } catch {
        setStatus("AX parse error");
      }
    };
    source.addEventListener("error", () => {
      setStatus("AX reconnecting");
    });
    return () => source.close();
  }, [endpoint]);

  return { snapshot, status };
}

export interface AxSnapshotContextValue {
  snapshot: AxSnapshot | null;
  status: string;
}

export interface AxSelectionContextValue {
  highlightedKey: string | null;
  selectedKey: string | null;
  setHighlightedKey: (key: string | null) => void;
  setSelectedKey: (key: string | null) => void;
}

export const AxSnapshotContext = createContext<AxSnapshotContextValue>({
  snapshot: null,
  status: "AX off",
});
export const AxSelectionContext = createContext<AxSelectionContextValue | null>(null);

export function useAxSnapshotContext() {
  return useContext(AxSnapshotContext);
}

export function useAxSelectionContext() {
  const context = useContext(AxSelectionContext);
  if (!context) throw new Error("AX selection context is unavailable");
  return context;
}
