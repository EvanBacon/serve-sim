import { useCallback, useState } from "react";
import { deviceKind, runtimeOrder, type SimDevice } from "../utils/devices";
import { simEndpoint } from "../utils/sim-endpoint";

// ─── Empty state: pick a simulator to boot ───
//
// When no serve-sim helper is running, the middleware has no state file to
// inject and `window.__SIM_PREVIEW__` is undefined. Instead of telling the
// user to drop into a terminal, list available simulators inline and let
// them boot one + start `serve-sim --detach` from the browser.
export function BootEmptyState({
  devices,
  loading,
  error,
  onRefresh,
}: {
  devices: SimDevice[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [startingUdid, setStartingUdid] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const start = useCallback(async (d: SimDevice) => {
    if (startingUdid) return;
    setStartingUdid(d.udid);
    setStartError(null);
    try {
      const apiUrl = `${simEndpoint("api")}?device=${encodeURIComponent(d.udid)}`;
      const navigateWhenReady = (async () => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          try {
            const r = await fetch(apiUrl, { cache: "no-store" });
            if (r.ok && (await r.json())) {
              const nextUrl = new URL(window.location.href);
              nextUrl.searchParams.set("device", d.udid);
              window.location.assign(nextUrl.toString());
              return true;
            }
          } catch {}
          await new Promise((res) => setTimeout(res, 400));
        }
        return false;
      })();

      const startUrl = simEndpoint("grid/api/start");
      const startReq = fetch(startUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ udid: d.udid }),
      })
        .then(async (res) => {
          const json = await res.json().catch(() => ({} as any));
          if (!res.ok || !json.ok) {
            throw new Error(json.error ?? `HTTP ${res.status}`);
          }
        });

      const navigated = await Promise.race([
        navigateWhenReady,
        startReq.then(() => "started" as const),
      ]);

      if (navigated === true) return;
      const ready = await navigateWhenReady;
      if (ready) return;
      throw new Error("serve-sim started but no stream state appeared");
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Failed to start stream");
      setStartingUdid(null);
    }
  }, [startingUdid]);

  const grouped = new Map<string, SimDevice[]>();
  for (const d of devices) {
    let list = grouped.get(d.runtime);
    if (!list) { list = []; grouped.set(d.runtime, list); }
    list.push(d);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => {
      const ab = a.state === "Booted" ? 0 : 1;
      const bb = b.state === "Booted" ? 0 : 1;
      if (ab !== bb) return ab - bb;
      return deviceKind(a.name) - deviceKind(b.name) || a.name.localeCompare(b.name);
    });
  }
  const sortedGroups = [...grouped.entries()].sort(
    ([a], [b]) => runtimeOrder(a) - runtimeOrder(b) || a.localeCompare(b),
  );

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-page p-6 gap-3 font-system box-border">
      <div className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-[18px] m-0 text-white/90">No serve-sim stream running</h1>
        <p className="text-white/55 text-[14px] max-w-120">
          Pick a simulator to boot, or start one yourself with{" "}
          <code className="bg-[#222] px-1.5 py-0.5 rounded text-[13px]">bunx serve-sim --detach</code>.
        </p>
        <div className="w-full max-w-90 mt-2 bg-panel border border-white/12 rounded-[10px] p-1 font-mono text-[13px] text-white/90 text-left max-h-[70vh] overflow-y-auto min-h-0">
          <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] text-white/65">
            <span className="font-semibold">Simulators</span>
            <button onClick={onRefresh} disabled={loading} className="bg-transparent border-none text-accent text-[11px] cursor-pointer p-0">
              {loading ? "..." : "Refresh"}
            </button>
          </div>
          {error && <div className="px-2.5 py-1.5 text-danger text-[11px]">{error}</div>}
          {startError && <div className="px-2.5 py-1.5 text-danger text-[11px]">{startError}</div>}
          {!loading && !error && devices.length === 0 && (
            <div className="p-3 text-white/40 text-[11px] text-center">No available simulators found</div>
          )}
          {sortedGroups.map(([runtime, devs]) => (
            <div key={runtime}>
              <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold text-white/40 uppercase tracking-[0.08em]">{runtime}</div>
              {devs.map((d) => {
                const isStarting = startingUdid === d.udid;
                const disabled = startingUdid !== null && !isStarting;
                const isBooted = d.state === "Booted";
                return (
                  <div
                    key={d.udid}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md transition-colors ${disabled ? "cursor-default opacity-50" : "cursor-pointer hover:bg-white/8"}`}
                    onClick={() => { if (!disabled) start(d); }}
                  >
                    <span
                      className="size-1.5 rounded-full shrink-0"
                      style={{ background: isBooted ? "#4ade80" : "#444" }}
                    />
                    <span className="flex-1 text-left">{d.name}</span>
                    <span className={`text-[10px] ${isStarting ? "text-accent" : "text-white/55"}`}>
                      {isStarting
                        ? (isBooted ? "Starting..." : "Booting...")
                        : (isBooted ? "Start stream" : "Boot & stream")}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
