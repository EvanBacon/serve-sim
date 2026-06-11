import type { DragEvent } from "react";
import type { ScreenshotToast as ScreenshotToastState } from "../hooks/use-screenshot-toast";
import { DROP_HOST_PATH_TYPE } from "../utils/drop";

interface ScreenshotToastProps {
  toast: ScreenshotToastState;
  onReveal: () => void;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}

// Encode a host path into a file:// URL, escaping each segment so spaces and
// other characters survive a drop into a text field.
function fileUrlFor(path: string): string {
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}

export function ScreenshotToast({
  toast,
  onReveal,
  onDismiss,
  onPause,
  onResume,
}: ScreenshotToastProps) {
  const leaving = toast.phase === "out";
  const animClass = leaving
    ? "animate-[serve-sim-toast-pop-out_0.2s_ease-in_forwards]"
    : "animate-[serve-sim-toast-pop-in_0.22s_cubic-bezier(0.2,0.8,0.2,1)]";

  // The exit animation finishing is our cue to actually unmount; the enter
  // animation also fires this, so gate on the leaving phase.
  const handleAnimationEnd = () => {
    if (leaving) onDismiss();
  };

  const handleDragStart = (e: DragEvent<HTMLButtonElement>) => {
    if (!toast.path) {
      e.preventDefault();
      return;
    }
    onPause();
    // Hand over the file URL as plain text only. Offering `text/uri-list` (or
    // `DownloadURL`) makes rich-text targets build a hyperlink, and Chrome
    // blocks `file://` hrefs — the drop then lands as "[…](about:blank#blocked)".
    // Plain text inserts the literal URL into any text field.
    e.dataTransfer.setData("text/plain", fileUrlFor(toast.path));
    // Dropping onto the simulator adds the screenshot to Photos in place.
    e.dataTransfer.setData(DROP_HOST_PATH_TYPE, toast.path);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40"
      onMouseEnter={onPause}
      onMouseLeave={onResume}
    >
      <div className={animClass} onAnimationEnd={handleAnimationEnd}>
        {toast.status === "error" ? (
          <div className="flex items-center gap-2 px-3.5 py-2.5 bg-panel border border-white/12 rounded-xl text-white/90 text-[12px] shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
            <span className="size-1.5 rounded-full shrink-0 bg-[#f87171]" />
            <span className="select-text">{toast.message ?? "Screenshot failed"}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={onReveal}
            disabled={toast.status !== "saved"}
            draggable={toast.status === "saved"}
            onDragStart={handleDragStart}
            onDragEnd={onResume}
            aria-label="Open screenshot in Finder"
            title="Click to reveal in Finder · drag to copy the file"
            className="group flex items-center gap-3 pl-2 pr-3.5 py-2 bg-panel border border-white/12 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-left cursor-pointer enabled:hover:bg-[#2a2a2c] disabled:cursor-default [transition:background_0.15s_ease]"
          >
            <div className="size-9 rounded-md overflow-hidden bg-white/10 shrink-0 flex items-center justify-center ring-1 ring-white/10 pointer-events-none">
              {toast.thumb ? (
                <img src={toast.thumb} alt="" className="size-full object-cover" draggable={false} />
              ) : (
                <span className="block size-4 rounded-full border-2 border-white/30 border-t-white animate-[grid-spin_0.8s_linear_infinite]" />
              )}
            </div>
            <div className="flex flex-col leading-tight pointer-events-none">
              <span className="text-[13px] font-semibold text-white">
                {toast.status === "saving" ? "Saving Screenshot…" : "Screenshot Saved"}
              </span>
              {toast.status === "saved" && (
                <span className="text-[11px] text-white/60">Open in Finder</span>
              )}
            </div>
            {toast.status === "saved" && (
              <svg
                className="ml-1 text-white/80 pointer-events-none"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
