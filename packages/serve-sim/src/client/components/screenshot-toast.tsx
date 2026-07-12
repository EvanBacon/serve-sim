import { useEffect, useRef, useState, type DragEvent } from "react";
import { ChevronRight } from "lucide-react";
import type { ScreenshotToast as ScreenshotToastState } from "../hooks/use-screenshot-toast";
import { DROP_HOST_PATH_TYPE } from "../utils/drop";

interface ScreenshotToastProps {
  toast: ScreenshotToastState;
  onReveal: () => void;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}

const DRAG_FALLBACK_RESUME_MS = 8000;

// Encode a host path into a file:// URL, escaping each segment so spaces and
// other characters survive a drop into a text field.
function fileUrlFor(path: string): string {
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}

export function shouldDismissScreenshotToastAfterDrag(dropEffect: DataTransfer["dropEffect"]): boolean {
  return dropEffect !== "none";
}

export function ScreenshotToast({
  toast,
  onReveal,
  onDismiss,
  onPause,
  onResume,
}: ScreenshotToastProps) {
  const [dragging, setDragging] = useState(false);
  const dragImageRef = useRef<HTMLImageElement | null>(null);
  const dragFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDragFallback = () => {
    if (dragFallbackTimerRef.current) clearTimeout(dragFallbackTimerRef.current);
    dragFallbackTimerRef.current = null;
  };

  useEffect(() => () => clearDragFallback(), []);

  const handleDragStart = (e: DragEvent<HTMLButtonElement>) => {
    if (!toast.path) {
      e.preventDefault();
      return;
    }
    clearDragFallback();
    onPause();
    dragFallbackTimerRef.current = setTimeout(() => {
      dragFallbackTimerRef.current = null;
      setDragging(false);
      onResume();
    }, DRAG_FALLBACK_RESUME_MS);
    // Hand over the file URL as plain text only. Offering `text/uri-list` (or
    // `DownloadURL`) makes rich-text targets build a hyperlink, and Chrome
    // blocks `file://` hrefs — the drop then lands as "[…](about:blank#blocked)".
    // Plain text inserts the literal URL into any text field.
    e.dataTransfer.setData("text/plain", fileUrlFor(toast.path));
    // Dropping onto the simulator adds the screenshot to Photos in place.
    e.dataTransfer.setData(DROP_HOST_PATH_TYPE, toast.path);
    e.dataTransfer.effectAllowed = "copy";
    // Drag the thumbnail, not a snapshot of the pill — the snapshot clips the
    // pill's box-shadow at its rounded corners.
    const img = dragImageRef.current;
    if (img) e.dataTransfer.setDragImage(img, img.offsetWidth / 2, img.offsetHeight / 2);
    // Hide the pill so the drag image is the only visible instance. Deferred a
    // frame: the browser captures the drag image synchronously on dragstart,
    // and hiding the source now would capture a blank.
    requestAnimationFrame(() => setDragging(true));
  };

  const handleDragEnd = (e: DragEvent<HTMLButtonElement>) => {
    clearDragFallback();
    setDragging(false);
    if (shouldDismissScreenshotToastAfterDrag(e.dataTransfer.dropEffect)) onDismiss();
    else onResume();
  };

  return (
    <div
      data-testid="screenshot-toast"
      className="w-[min(320px,calc(100vw-32px))]"
      onMouseEnter={onPause}
      onMouseLeave={onResume}
    >
      {/* Offscreen source for setDragImage. Must stay rendered (not
          display:none) or the browser captures nothing; parked far above the
          viewport instead. Absolute, not fixed: the wrapper's -translate-x-1/2
          makes it the containing block for fixed descendants, which would put
          a "fixed" image right back into the page. Inline styles, not
          Tailwind, so the class scan can never miss them. */}
      {toast.thumb && (
        <img
          ref={dragImageRef}
          data-testid="drag-image"
          src={toast.thumb}
          alt=""
          aria-hidden
          draggable={false}
          style={{
            position: "absolute",
            top: -9999,
            left: 0,
            width: 80,
            height: 80,
            borderRadius: 12,
            objectFit: "cover",
            pointerEvents: "none",
          }}
        />
      )}
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
          onDragEnd={handleDragEnd}
          aria-label="Open screenshot in Finder"
          title="Click to reveal in Finder · drag to copy the file"
          className={`group flex w-full items-center gap-3 pl-2 pr-3.5 py-2 bg-panel border border-white/12 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-left cursor-pointer enabled:hover:bg-[#2a2a2c] disabled:cursor-default [transition:background_0.15s_ease] ${dragging ? "invisible" : ""}`}
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
            <ChevronRight
              className="ml-auto text-white/80 pointer-events-none"
              size={16}
              strokeWidth={2.25}
            />
          )}
        </button>
      )}
    </div>
  );
}
