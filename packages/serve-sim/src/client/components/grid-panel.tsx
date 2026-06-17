import { useMemo, useState } from "react";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";
import { useGridMemory } from "../hooks/use-grid-memory";
import { type GridDevice, runtimeLabel } from "../utils/grid";
import { simEndpoint } from "../utils/sim-endpoint";
import { GridCapacityBanner } from "./grid-capacity-banner";
import { DeviceRow } from "./device-row";

// The device sidebar: the merged picker + grid. A search field, a scrollable
// list of horizontal device rows (Xcode-style), and a capacity footer. Device
// data and start/shutdown actions are owned by App so selecting a row can swap
// the main stream instantly — this component is presentational.
export function GridPanel({
  open,
  onClose,
  width,
  side = "right",
  devices,
  selectedUdid,
  onSelect,
  starting,
  shuttingDown,
  onShutdown,
}: {
  open: boolean;
  onClose: () => void;
  width: number;
  side?: "left" | "right";
  devices: GridDevice[] | null;
  selectedUdid: string | null;
  onSelect: (udid: string) => void;
  starting: Record<string, boolean>;
  shuttingDown: Record<string, boolean>;
  onShutdown: (udid: string) => void;
}) {
  const config = window.__SIM_PREVIEW__;
  const memoryEndpoint = config?.gridMemoryEndpoint ?? simEndpoint("grid/api/memory");
  const memory = useGridMemory(memoryEndpoint, open);

  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !devices) return devices;
    return devices.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        runtimeLabel(d.runtime).toLowerCase().includes(q),
    );
  }, [devices, query]);

  return (
    <Panel open={open} width={width} side={side}>
      <PanelHeader>
        <PanelTitle>Simulators</PanelTitle>
        <PanelCloseButton onClick={onClose} />
      </PanelHeader>

      <div className="px-3 pb-2 pt-0.5 shrink-0">
        <label className="flex items-center gap-2 px-2.5 h-8 rounded-lg bg-white/6 focus-within:bg-white/10 [transition:background_0.12s]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40 shrink-0">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent border-none outline-none text-[13px] text-white/90 placeholder:text-white/40"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="shrink-0 grid place-items-center size-4 rounded-full bg-white/15 text-white/70 hover:bg-white/25"
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </label>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {filtered === null ? null : filtered.length === 0 ? (
          <div className="px-2 py-6 text-white/40 text-[12px] text-center">
            {query ? "No matching simulators." : "No iOS simulators available."}
          </div>
        ) : (
          <>
            <div className="px-2 pt-1 pb-1 text-[11px] font-semibold text-white/40 uppercase tracking-wide">
              Available
            </div>
            <div className="flex flex-col gap-0.5">
              {filtered.map((d) => (
                <DeviceRow
                  key={d.device}
                  device={d}
                  active={d.device === selectedUdid}
                  starting={!!starting[d.device]}
                  shuttingDown={!!shuttingDown[d.device]}
                  onSelect={() => onSelect(d.device)}
                  onShutdown={() => onShutdown(d.device)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {memory && memory.totalBytes > 0 && (
        <div className="shrink-0 px-3 py-2 border-t border-white/8 flex justify-center">
          <GridCapacityBanner report={memory} />
        </div>
      )}
    </Panel>
  );
}
