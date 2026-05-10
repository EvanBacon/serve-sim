import { useCallback, useEffect, useState } from "react";
import type { GridDevice } from "../utils/grid";

export function useGridDevices(
  endpoint: string | undefined,
  enabled: boolean,
  fast: boolean,
) {
  const [devices, setDevices] = useState<GridDevice[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (!enabled || !endpoint) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(endpoint, { cache: "no-store" });
        const json = await res.json();
        if (!cancelled) setDevices(json.devices ?? []);
      } catch {
        if (!cancelled) setDevices([]);
      }
    };
    tick();
    const id = setInterval(tick, fast ? 750 : 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [endpoint, enabled, refreshKey, fast]);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  return { devices, refresh };
}
