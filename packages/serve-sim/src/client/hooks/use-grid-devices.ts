import { useCallback, useEffect, useState } from "react";
import type { GridDevice } from "../utils/grid";

/** Devices fetched up front; the long tail loads as the sidebar scrolls. */
const DEFAULT_PAGE_SIZE = 60;
/** Upper bound matching the server's clamp — one request covers any catalog. */
const LOAD_ALL_LIMIT = 1000;

/**
 * Fetches the grid device list with server-side pagination. The most relevant
 * devices (streaming → booted → last-opened) sort first, so the initial page is
 * the useful one; `loadMore`/`loadAll` grow the window. Over a tunnel this
 * keeps the first paint small instead of pulling the whole simulator catalog
 * (and its DeviceKit chrome) on every poll.
 *
 * `limit` is always requested from offset 0 (not a sliding window): the top of
 * the list is what changes — boots, shutdowns, the active stream — so refetching
 * `[0, limit)` keeps those fresh while merging is trivial (the response *is* the
 * visible list).
 */
export function useGridDevices(
  endpoint: string | undefined,
  enabled: boolean,
  fast: boolean,
  pageSize: number = DEFAULT_PAGE_SIZE,
) {
  const [devices, setDevices] = useState<GridDevice[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(pageSize);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (!enabled || !endpoint) return;
    let cancelled = false;
    const sep = endpoint.includes("?") ? "&" : "?";
    const tick = async () => {
      try {
        const res = await fetch(`${endpoint}${sep}limit=${limit}&offset=0`, { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        setDevices(json.devices ?? []);
        if (typeof json.total === "number") setTotal(json.total);
      } catch {
        if (!cancelled) setDevices([]);
      }
    };
    tick();
    const id = setInterval(tick, fast ? 750 : 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [endpoint, enabled, refreshKey, fast, limit]);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const loadMore = useCallback(() => setLimit((l) => l + pageSize), [pageSize]);
  const loadAll = useCallback(() => setLimit(LOAD_ALL_LIMIT), []);
  // Return to the paged window — e.g. when search is cleared — so the poll stops
  // pulling the whole catalog every interval after a one-off `loadAll`.
  const resetPage = useCallback(() => setLimit(pageSize), [pageSize]);
  const hasMore = total > (devices?.length ?? 0);
  return { devices, total, refresh, loadMore, loadAll, resetPage, hasMore };
}
