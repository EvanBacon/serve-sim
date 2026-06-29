import { useCallback, useEffect, useState } from "react";
import type { GridDevice } from "../utils/grid";
import { openHostEventStream } from "../utils/exec";

/** Devices fetched up front; the long tail loads as the sidebar scrolls. */
const DEFAULT_PAGE_SIZE = 60;
/** Upper bound matching the server's clamp — one request covers any catalog. */
const LOAD_ALL_LIMIT = 1000;

/**
 * Live device grid over the exec websocket. The server pushes the same payload
 * as `GET /grid/api` (sorted, paginated `[0, limit)` window) whenever the
 * device set changes — boot, shutdown, erase, including transitions driven from
 * outside serve-sim — or a helper starts/stops. There's no polling interval:
 * updates are event-driven, and every (re)connect re-sends the full window so a
 * dropped socket re-syncs automatically.
 *
 * `limit` is always requested from offset 0 (not a sliding window): the top of
 * the list is what changes — boots, shutdowns, the active stream — so streaming
 * `[0, limit)` keeps those fresh while merging is trivial (the payload *is* the
 * visible list). `loadMore`/`loadAll` grow the window by reconnecting with a
 * larger `limit`.
 */
export function useGridDevices(
  endpoint: string | undefined,
  enabled: boolean,
  pageSize: number = DEFAULT_PAGE_SIZE,
) {
  const [devices, setDevices] = useState<GridDevice[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(pageSize);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (!enabled || !endpoint) return;
    const eventsPath = `${endpoint}/events?limit=${limit}`;
    const es = openHostEventStream(eventsPath);
    es.onmessage = (event) => {
      try {
        const json = JSON.parse(event.data) as { devices?: GridDevice[]; total?: number };
        setDevices(json.devices ?? []);
        if (typeof json.total === "number") setTotal(json.total);
      } catch {
        // Ignore malformed frames; the next push (or a reconnect) re-syncs.
      }
    };
    return () => es.close();
  }, [endpoint, enabled, refreshKey, limit]);
  // Force a reconnect → immediate re-send (e.g. right after a UI boot/shutdown,
  // so the list reflects the action without waiting on the server-side debounce).
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const loadMore = useCallback(() => setLimit((l) => l + pageSize), [pageSize]);
  const loadAll = useCallback(() => setLimit(LOAD_ALL_LIMIT), []);
  // Return to the paged window — e.g. when search is cleared — after a one-off
  // `loadAll`, so the stream stops pushing the whole catalog.
  const resetPage = useCallback(() => setLimit(pageSize), [pageSize]);
  const hasMore = total > (devices?.length ?? 0);
  return { devices, total, refresh, loadMore, loadAll, resetPage, hasMore };
}
