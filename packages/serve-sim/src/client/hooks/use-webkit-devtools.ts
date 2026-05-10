import { useCallback, useEffect, useState } from "react";
import type { WebKitDevtoolsResponse, WebKitDevtoolsTarget } from "../utils/devtools";

export function useWebKitDevtools(endpoint: string | undefined, enabled: boolean) {
  const [targets, setTargets] = useState<WebKitDevtoolsTarget[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!endpoint) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { cache: "no-store" });
      const json = (await res.json()) as WebKitDevtoolsResponse;
      if (!res.ok || json.error) throw new Error(json.error || "Failed to list WebKit targets");
      setTargets(json.targets ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start WebKit DevTools");
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  return { targets, error, loading, refresh };
}
