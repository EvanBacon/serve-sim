import { getDeviceType } from "../simulator";
import { X } from "lucide-react";
import { type GridDevice, runtimeVersion } from "../utils/grid";
import { DeviceGlyph } from "./device-glyph";

// A single horizontal device row in the sidebar (Xcode-style): family glyph,
// name + status, and the runtime version on the trailing edge. Clicking the row
// selects the device — the main view swaps to its stream, or to a placeholder
// when it isn't running yet.
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
  const duo =
    /duo/i.test(device.name) ||
    (Array.isArray(device.displays) && device.displays.length > 1);
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
  const dotColor = helper ? "var(--serve-sim-success-emerald)" : isBooted ? "var(--serve-sim-caution)" : null;
  const canShutdown = helper || isBooted;
  const iconBackingClass = helper
    ? active
      ? "bg-live-icon-active"
      : "bg-live-icon"
    : active
    ? "bg-ink/15"
    : "bg-ink/6";
  const iconColorClass = helper ? "text-live-icon-fg" : active ? "text-ink-90" : "text-ink-55";

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
          ? "bg-ink/10 text-ink"
          : "text-ink-90 hover:bg-ink/8"
      }`}
    >
      <div
        className={`relative shrink-0 grid place-items-center size-9 rounded-[9px] overflow-hidden ${iconBackingClass}`}
      >
        <span className={iconColorClass}>
          <DeviceGlyph type={type} duo={duo} screenOn={Boolean(helper)} />
        </span>
        {dotColor && !helper && (
          <span
            className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full ring-2 ring-panel"
            style={{ background: dotColor }}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-tight">{device.name}</div>
        {status && (
          <div
            className={`truncate text-[11px] leading-tight ${
              helper ? "text-success-emerald" : active ? "text-ink-75" : "text-ink-45"
            }`}
          >
            {status}
          </div>
        )}
      </div>

      <div
        data-testid="device-row-trailing-slot"
        className="relative shrink-0 w-8 h-6 flex items-center justify-end"
      >
        <span
          className={`absolute right-0 text-[11px] font-mono tabular-nums [transition:opacity_0.12s] ${
            active ? "text-ink-85" : "text-ink-40"
          } ${canShutdown ? "group-hover:opacity-0 group-focus-within:opacity-0" : ""}`}
        >
          {version}
        </span>

        {canShutdown && (
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
            className={`absolute right-0 top-1/2 -translate-y-1/2 grid place-items-center size-5 rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [transition:opacity_0.12s,background_0.12s,color_0.12s] ${
              active ? "text-ink-80 hover:bg-ink/20" : "text-ink-70 hover:bg-ink/12 hover:text-ink"
            }`}
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        )}
      </div>
    </div>
  );
}
