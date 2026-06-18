import { useMemo, useState } from "react";
import { PanelLeft, Search, X } from "lucide-react";
import { Panel, PanelHeader, PanelTitle } from "../Panel";
import { useGridMemory } from "../hooks/use-grid-memory";
import { type GridDevice, type MemoryReport, runtimeLabel } from "../utils/grid";
import { simEndpoint } from "../utils/sim-endpoint";
import { GridCapacityBanner } from "./grid-capacity-banner";
import { DeviceRow } from "./device-row";

const DEVICE_SKELETON_ROWS = 12;

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
  const config = typeof window === "undefined" ? undefined : window.__SIM_PREVIEW__;
  const memoryEndpoint =
    config?.gridMemoryEndpoint ??
    (typeof window === "undefined" ? undefined : simEndpoint("grid/api/memory"));
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
      <PanelHeader
        style={{ justifyContent: "flex-start", paddingLeft: 16, paddingTop: 16, gap: 4 }}
      >
        <button
          type="button"
          onClick={onClose}
          className="flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-[#8e8e93] [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-white/8 hover:text-white"
          aria-label="Close devices sidebar"
          aria-pressed
          title="Devices"
        >
          <PanelLeft size={18} strokeWidth={1.75} />
        </button>
        <PanelTitle>Devices</PanelTitle>
      </PanelHeader>

      <div className="px-3 pb-2 pt-0.5 shrink-0">
        <label className="flex items-center gap-2 px-2.5 h-8 rounded-lg bg-white/6 focus-within:bg-white/10 [transition:background_0.12s]">
          <Search size={14} strokeWidth={2} className="text-white/40 shrink-0" />
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
              <X size={9} strokeWidth={3} />
            </button>
          )}
        </label>
      </div>

      <div className="relative flex-1 min-h-0">
        <div className="h-full min-h-0 overflow-y-auto px-2 py-2 [scrollbar-width:thin]">
          {filtered === null ? (
            <DeviceListSkeleton />
          ) : filtered.length === 0 ? (
            <div className="px-2 py-6 text-white/40 text-[12px] text-center">
              {query ? "No matching simulators." : "No iOS simulators available."}
            </div>
          ) : (
            <>
              <div className="px-2 pt-1 pb-1 text-[11px] font-semibold text-white/40 uppercase tracking-wide">
                Available
              </div>
              <div className="flex flex-col gap-0.5 pb-1">
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
        <div
          data-testid="device-list-top-fade"
          className="absolute top-0 left-0 right-0 h-[16px] pointer-events-none bg-[linear-gradient(to_bottom,rgba(20,20,22,0.96)_0%,rgba(20,20,22,0)_100%)]"
        />
        <div
          data-testid="device-list-bottom-fade"
          className="absolute bottom-0 left-0 right-0 h-[16px] pointer-events-none bg-[linear-gradient(to_top,rgba(20,20,22,0.96)_0%,rgba(20,20,22,0)_100%)]"
        />
      </div>

      <GridCapacityFooter report={memory} />
    </Panel>
  );
}

export function DeviceListSkeleton() {
  return (
    <>
      <div className="px-2 pt-1 pb-1 text-[11px] font-semibold text-white/40 uppercase tracking-wide">
        Available
      </div>
      <div
        data-testid="device-list-skeleton"
        className="flex flex-col gap-0.5 pb-1"
        aria-label="Loading simulators"
        aria-busy="true"
      >
        {Array.from({ length: DEVICE_SKELETON_ROWS }, (_, index) => (
          <DeviceRowSkeleton key={index} index={index} />
        ))}
      </div>
    </>
  );
}

function DeviceRowSkeleton({ index }: { index: number }) {
  const nameWidth = ["w-[62%]", "w-[74%]", "w-[58%]", "w-[70%]"][index % 4]!;
  const statusWidth = ["w-[42%]", "w-[36%]", "w-[48%]", "w-[32%]"][index % 4]!;
  const versionWidth = ["w-7", "w-6", "w-8"][index % 3]!;

  return (
    <div
      data-testid="device-row-skeleton"
      className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg select-none"
      aria-hidden="true"
    >
      <div className="relative shrink-0 grid place-items-center size-9 rounded-[9px] overflow-hidden bg-white/6">
        <span className="size-4 rounded-[4px] bg-white/[0.12]" />
      </div>
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        <span className={`h-3 rounded-full bg-white/[0.12] ${nameWidth}`} />
        <span className={`h-2.5 rounded-full bg-white/[0.08] ${statusWidth}`} />
      </div>
      <span className={`shrink-0 h-2.5 rounded-full bg-white/[0.08] ${versionWidth}`} />
    </div>
  );
}

export function GridCapacityFooter({ report }: { report: MemoryReport | null }) {
  if (!report || report.totalBytes <= 0) return null;
  return (
    <div className="shrink-0 min-w-0 overflow-hidden px-3 py-2 flex justify-center">
      <GridCapacityBanner report={report} />
    </div>
  );
}
