import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AxSelectionContext,
  AxSnapshotContext,
  useAxSnapshot,
} from "../hooks/use-ax-snapshot";

export function AxStateProvider({
  endpoint,
  children,
}: {
  endpoint?: string;
  children: ReactNode;
}) {
  const { snapshot, status } = useAxSnapshot(endpoint);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!endpoint) {
      setHighlightedKey(null);
      setSelectedKey(null);
    }
  }, [endpoint]);

  const snapshotValue = useMemo(
    () => ({ snapshot, status }),
    [snapshot, status],
  );
  const selectionValue = useMemo(
    () => ({
      highlightedKey,
      selectedKey,
      setHighlightedKey,
      setSelectedKey,
    }),
    [highlightedKey, selectedKey],
  );

  return (
    <AxSnapshotContext value={snapshotValue}>
      <AxSelectionContext value={selectionValue}>
        {children}
      </AxSelectionContext>
    </AxSnapshotContext>
  );
}
