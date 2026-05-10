import { useEffect, useMemo, useState } from "react";
import { appIconCache, fetchAppIcon } from "../utils/app-icon";
import { execOnHost } from "../utils/exec";

export function useAppIcons(udid: string | null | undefined, bundleIds: string[]) {
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  // Stable key so the effect re-runs only when the *set* of bundle ids changes.
  // Memoize so the sort doesn't run on every render.
  const sig = useMemo(() => bundleIds.slice().sort().join("|"), [bundleIds]);
  useEffect(() => {
    if (!udid) return;
    let cancelled = false;
    for (const bundleId of bundleIds) {
      if (!bundleId) continue;
      const cacheKey = `${udid}:${bundleId}`;
      const cached = appIconCache.get(cacheKey);
      if (typeof cached === "string" || cached === null) {
        setIcons((prev) => (prev[bundleId] === cached ? prev : { ...prev, [bundleId]: cached as string | null }));
        continue;
      }
      void fetchAppIcon(execOnHost, udid, bundleId).then((url) => {
        if (cancelled) return;
        setIcons((prev) => ({ ...prev, [bundleId]: url }));
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [udid, sig]);
  return icons;
}
