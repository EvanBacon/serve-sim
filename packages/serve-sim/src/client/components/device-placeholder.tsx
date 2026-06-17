import { type CSSProperties } from "react";
import {
  DeviceFrameChrome,
  fallbackScreenSize,
  getDeviceType,
  screenBorderRadius,
  simulatorAspectRatio,
  simulatorMaxWidth,
} from "serve-sim-client/simulator";
import { runtimeLabel } from "../utils/grid";

// Shown in the main view when the selected device isn't streaming yet: a static
// device frame with a blank blue screen, the device name + runtime, and a Start
// button that boots/streams it. Mirrors Xcode's "device not running" state.
export function DevicePlaceholder({
  name,
  runtime,
  busy,
  busyLabel = "Starting…",
  error,
  onStart,
}: {
  name: string;
  runtime: string;
  busy: boolean;
  busyLabel?: string;
  error: string | null;
  onStart: () => void;
}) {
  const type = getDeviceType(name);
  const screen = fallbackScreenSize(type, name);
  const aspectRatio = simulatorAspectRatio(screen);
  const maxWidth = simulatorMaxWidth(type, screen);
  const imgBorderRadius = screenBorderRadius(type, screen);

  return (
    <div className="flex flex-col items-center gap-5 min-w-0">
      <div
        className="relative w-full"
        style={{ maxWidth, aspectRatio }}
      >
        {/* Blank screen — a soft blue gradient like an unloaded simulator. */}
        <div
          className="absolute inset-0"
          style={{
            borderRadius: imgBorderRadius,
            cornerShape: "superellipse(1.3)",
            background: "linear-gradient(160deg, #6fa8e6 0%, #5b93d6 55%, #5188cf 100%)",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)",
          } as CSSProperties}
        />
        <div className="absolute inset-0 pointer-events-none">
          <DeviceFrameChrome type={type} />
        </div>
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <div className="text-[17px] font-semibold text-white/90">{name}</div>
        <div className="text-[13px] text-white/45">{runtimeLabel(runtime)} Simulator</div>
      </div>

      {error && <div className="text-danger text-[12px] font-mono max-w-90 text-center">{error}</div>}

      <button
        type="button"
        onClick={onStart}
        disabled={busy}
        className={`flex items-center gap-2 px-5 py-2 rounded-full text-[14px] font-medium [transition:background_0.15s] ${
          busy
            ? "bg-white/8 text-white/55 cursor-default"
            : "bg-white/12 text-white/90 hover:bg-white/18 cursor-pointer"
        }`}
      >
        {busy && (
          <span
            aria-hidden
            className="size-3.5 rounded-full border-2 border-white/25 animate-[grid-spin_0.8s_linear_infinite]"
            style={{ borderTopColor: "rgba(255,255,255,0.9)" }}
          />
        )}
        {busy ? busyLabel : "Start"}
      </button>
    </div>
  );
}
