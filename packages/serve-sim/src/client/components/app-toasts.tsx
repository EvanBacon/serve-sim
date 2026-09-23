import type { CSSProperties } from "react";
import { Toaster } from "sonner";
import type { UploadToast } from "../hooks/use-upload-toasts";

// Sonner paints its panel only when `data-styled` is true. `toast.custom()`
// (uploads, screenshots) opts out per call. A toaster-wide `unstyled: true`
// also opts out `toast.error` / `toast.success`, which drops the panel,
// width, and wrap and leaves a bare icon on the black canvas.
const toasterStyle = {
  zIndex: 2147483647,
  "--normal-bg": "#1c1c1e",
  "--normal-border": "rgba(255, 255, 255, 0.12)",
  "--normal-text": "rgba(255, 255, 255, 0.9)",
  "--border-radius": "8px",
  "--width": "320px",
} as CSSProperties;

function StatusDot({ color }: { color: string }) {
  return (
    <span
      data-testid="plain-toast-dot"
      style={{
        display: "block",
        width: 6,
        height: 6,
        borderRadius: 999,
        background: color,
      }}
    />
  );
}

export function ServeSimToaster() {
  return (
    <Toaster
      theme="dark"
      position="bottom-center"
      visibleToasts={4}
      gap={8}
      offset={{ bottom: 24 }}
      className="serve-sim-toaster"
      icons={{
        error: <StatusDot color="#f87171" />,
        success: <StatusDot color="#4ade80" />,
        warning: <StatusDot color="#fbbf24" />,
        info: <StatusDot color="#a5b4fc" />,
      }}
      style={toasterStyle}
      containerAriaLabel="serve-sim notifications"
    />
  );
}

export function UploadToastContent({ toast }: { toast: UploadToast }) {
  const isError = toast.status === "error";
  const isUploading = toast.status === "uploading";
  const transferring = isUploading && toast.progress !== null;
  const pct = toast.progress != null ? Math.round(toast.progress * 100) : 0;

  return (
    <div
      data-testid="upload-toast"
      className={`flex w-[min(320px,calc(100vw-32px))] flex-col gap-1.5 px-3 py-2 bg-panel border border-white/12 rounded-lg text-white/90 text-[12px] font-mono shadow-[0_8px_24px_rgba(0,0,0,0.45)] ${isError ? "select-text cursor-text" : "select-none cursor-default"}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="size-1.5 rounded-full shrink-0 [transition:background_0.3s]"
          style={{
            background: isUploading
              ? "#a5b4fc"
              : toast.status === "success"
              ? "#4ade80"
              : "#f87171",
          }}
        />
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {isUploading && transferring && `Uploading ${toast.name}… ${pct}%`}
          {isUploading && !transferring &&
            (toast.kind === "ipa" ? `Installing ${toast.name}…` : `Adding ${toast.name}…`)}
          {toast.status === "success" &&
            (toast.kind === "ipa" ? `Installed ${toast.name}` : `Added ${toast.name} to Photos`)}
          {isError && `${toast.name}: ${toast.message ?? "Upload failed"}`}
        </span>
      </div>
      {isUploading && (
        <div className="relative h-[3px] w-full bg-white/8 rounded-[2px] overflow-hidden">
          {transferring ? (
            <div
              className="h-full bg-accent rounded-[2px] [transition:width_120ms_linear]"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="serve-sim-toast-indeterminate absolute top-0 left-0 h-full w-[40%] bg-accent rounded-[2px]" />
          )}
        </div>
      )}
    </div>
  );
}
