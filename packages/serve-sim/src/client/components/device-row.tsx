import { getDeviceType } from "serve-sim-client/simulator";
import { X } from "lucide-react";
import { type GridDevice, runtimeVersion } from "../utils/grid";
import { DeviceGlyph } from "./device-glyph";

// A single horizontal device row in the sidebar (Xcode-style): family glyph (or
// a live stream thumbnail when streaming), name + status, and the runtime
// version on the trailing edge. Clicking the row selects the device — the main
// view swaps to its stream, or to a placeholder when it isn't running yet.
export function DeviceRow({
  device,
  active,
  starting,
  shuttingDown,
  onSelect,
  onShutdown,
}: {
  device: GridDevice;
  active: boolean;
  starting: boolean;
  shuttingDown: boolean;
  onSelect: () => void;
  onShutdown: () => void;
}) {
  const helper = device.helper;
  const isBooted = device.state === "Booted";
  const type = getDeviceType(device.name);
  const version = runtimeVersion(device.runtime);

  const status = helper
    ? "Streaming"
    : starting
    ? (isBooted ? "Starting…" : "Booting…")
    : shuttingDown
    ? "Shutting down…"
    : isBooted
    ? "Booted"
    : null;
  const dotColor = helper ? "#34d399" : isBooted ? "#e9a13b" : null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group relative flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer select-none [transition:background_0.12s] ${
        active
          ? "bg-white/10 text-white"
          : "text-white/90 hover:bg-white/8"
      }`}
    >
      <div
        className={`relative shrink-0 grid place-items-center size-9 rounded-[9px] overflow-hidden ${
          active ? "bg-white/15" : "bg-white/6"
        }`}
      >
        {helper ? (
          <img
            src={helper.streamUrl}
            alt=""
            draggable={false}
            className="size-full object-cover"
          />
        ) : (
          <span className={active ? "text-white/90" : "text-white/55"}>
            <DeviceGlyph type={type} />
          </span>
        )}
        {dotColor && !helper && (
          <span
            className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full ring-2 ring-[#1c1c1e]"
            style={{ background: dotColor }}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-tight">{device.name}</div>
        {status && (
          <div
            className={`truncate text-[11px] leading-tight ${
              active ? "text-white/75" : helper ? "text-[#34d399]" : "text-white/45"
            }`}
          >
            {status}
          </div>
        )}
      </div>

      {(helper || isBooted) && (
        <button
          type="button"
          title={shuttingDown ? "Shutting down…" : "Shut down simulator"}
          aria-label="Shut down simulator"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onShutdown();
          }}
          disabled={shuttingDown}
          className={`shrink-0 grid place-items-center size-5 rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [transition:opacity_0.12s,background_0.12s] ${
            active ? "text-white/80 hover:bg-white/20" : "text-white/60 hover:bg-white/12 hover:text-white"
          }`}
        >
          <X size={13} strokeWidth={2.2} />
        </button>
      )}

      <span
        className={`shrink-0 text-[11px] font-mono tabular-nums ${
          active ? "text-white/85" : "text-white/40"
        } ${(helper || isBooted) ? "group-hover:hidden" : ""}`}
      >
        {version}
      </span>
    </div>
  );
}
