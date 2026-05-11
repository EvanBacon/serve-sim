import { useEffect, useState } from "react";
import type { MemoryReport } from "../utils/grid";

export function useGridMemory(endpoint: string | undefined, enabled: boolean) {
  const [report, setReport] = useState<MemoryReport | null>(null);
  useEffect(() => {
    if (!enabled || !endpoint) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(endpoint, { cache: "no-store" });
        const json = (await res.json()) as MemoryReport;
        if (!cancelled) setReport(json);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [endpoint, enabled]);
  return report;
}
