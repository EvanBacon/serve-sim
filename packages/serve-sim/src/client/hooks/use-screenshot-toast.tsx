import { useCallback, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import {
  RECORDING_TOAST_COPY,
  SCREENSHOT_TOAST_COPY,
  ScreenshotToast,
  type CaptureToastCopy,
} from "../components/screenshot-toast";
import { hostAction } from "../utils/exec";
import { videoFrameThumbnail } from "../utils/video-frame-thumbnail";

export type ScreenshotToast = {
  id: string;
  status: "saving" | "saved" | "error";
  // "in" while the pill is showing, "out" once the dismiss timer fires — the
  // component plays the exit animation, then calls dismiss() to unmount.
  phase: "in" | "out";
  // Absolute path on the host once the capture lands; used by "Open in Finder"
  // and the drag-and-drop file URL.
  path?: string;
  // data: URL of a downscaled preview, filled in best-effort after the save.
  thumb?: string;
  message?: string;
  /** Title/subtitle copy; screenshots when absent. */
  copy?: CaptureToastCopy;
  /** File name the browser saved (recordings: the host path is looked up). */
  fileName?: string;
};

// How long the success pill lingers before auto-dismissing. Hovering pauses
// the timer, so this only needs to be long enough to notice the pill — not to
// read and act on it.
const SAVED_DISMISS_MS = 3500;
const ERROR_DISMISS_MS = 4000;

/**
 * The capture card behind both screenshot and recording saves: one Sonner
 * toast at a time per hook, with hover-to-pause auto-dismiss, reveal on
 * click, and drag-to-copy (by the card component).
 */
function useCaptureToast(copy: CaptureToastCopy, revealToast: (toast: ScreenshotToast) => void) {
  const toastRef = useRef<ScreenshotToast | null>(null);
  const toastIdRef = useRef<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissDeadlineRef = useRef<number | null>(null);
  const remainingDismissMsRef = useRef<number | null>(null);
  const revealToastRef = useRef(revealToast);
  revealToastRef.current = revealToast;

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    dismissDeadlineRef.current = null;
  }, []);

  const dismiss = useCallback((id?: string | number) => {
    const targetId = id ?? toastIdRef.current ?? undefined;
    clearDismissTimer();
    remainingDismissMsRef.current = null;
    sonnerToast.dismiss(targetId);
    if (targetId === undefined || toastIdRef.current === String(targetId)) {
      toastRef.current = null;
      toastIdRef.current = null;
    }
  }, [clearDismissTimer]);

  const reveal = useCallback(() => {
    const t = toastRef.current;
    if (t) revealToastRef.current(t);
  }, []);

  const scheduleDismiss = useCallback((ms: number) => {
    clearDismissTimer();
    const delay = Math.max(0, ms);
    const id = toastIdRef.current;
    remainingDismissMsRef.current = delay;
    dismissDeadlineRef.current = Date.now() + delay;
    dismissTimerRef.current = setTimeout(() => dismiss(id ?? undefined), delay);
  }, [clearDismissTimer, dismiss]);

  const pauseDismiss = useCallback(() => {
    if (!dismissTimerRef.current || dismissDeadlineRef.current == null) return;
    remainingDismissMsRef.current = Math.max(0, dismissDeadlineRef.current - Date.now());
    clearDismissTimer();
  }, [clearDismissTimer]);

  const resumeDismiss = useCallback(() => {
    const remaining = remainingDismissMsRef.current;
    if (remaining == null) return;
    scheduleDismiss(remaining);
  }, [scheduleDismiss]);

  /** Draw `next`; a finite `duration` (re)starts the dismiss timer, `null` leaves it as is. */
  const render = useCallback((next: ScreenshotToast, duration: number | null = Infinity) => {
    const shown = next.copy ? next : { ...next, copy };
    toastRef.current = shown;
    toastIdRef.current = shown.id;
    sonnerToast.custom(
      (id) => (
        <ScreenshotToast
          toast={shown}
          onReveal={reveal}
          onDismiss={() => dismiss(id)}
          onPause={pauseDismiss}
          onResume={resumeDismiss}
        />
      ),
      // This toast draws its own panel. Leave Sonner's chrome for plain toasts.
      { id: shown.id, duration: Infinity, unstyled: true },
    );
    if (duration === null) return;
    if (Number.isFinite(duration)) scheduleDismiss(duration);
    else {
      clearDismissTimer();
      remainingDismissMsRef.current = null;
    }
  }, [clearDismissTimer, copy, dismiss, pauseDismiss, resumeDismiss, reveal, scheduleDismiss]);

  /** Patch the toast `id` if it is still the one showing; the timer keeps running (or paused). */
  const update = useCallback((id: string, patch: Partial<ScreenshotToast>) => {
    const current = toastRef.current;
    if (current?.id === id) render({ ...current, ...patch }, null);
  }, [render]);

  return { render, update, dismiss, reveal, toastRef };
}

export function useScreenshotToast(deviceUdid?: string | null, display?: "primary" | "primary-1") {
  const { render, dismiss, reveal, toastRef } = useCaptureToast(SCREENSHOT_TOAST_COPY, (t) => {
    if (t.path) void hostAction("revealScreenshot", { path: t.path });
  });

  const capture = useCallback(async () => {
    if (!deviceUdid) return;
    const id = crypto.randomUUID();
    render({ id, status: "saving", phase: "in" });

    // The server picks the absolute `~/Desktop/serve-sim-screenshot-<ts>.png`
    // path and returns it on success.
    let path: string;
    try {
      const res = await hostAction("screenshot", { udid: deviceUdid, ...(display ? { display } : {}) });
      path = typeof res.path === "string" ? res.path : "";
      if (res.exitCode !== 0 || !path) {
        render({ id, status: "error", phase: "in", message: res.stderr.trim() || "Screenshot failed" }, ERROR_DISMISS_MS);
        return;
      }
    } catch (e) {
      render({
        id,
        status: "error",
        phase: "in",
        message: e instanceof Error ? e.message : "Screenshot failed",
      }, ERROR_DISMISS_MS);
      return;
    }

    render({ id, status: "saved", phase: "in", path }, SAVED_DISMISS_MS);

    // Best-effort thumbnail: the server downscales to a temp PNG and returns
    // it base64'd. Failures (sips missing, etc.) just leave the placeholder.
    try {
      const tr = await hostAction("screenshotThumbnail", { path });
      const b64 = typeof tr.data === "string" ? tr.data.replace(/\s+/g, "") : "";
      if (b64) {
        const current = toastRef.current;
        if (current?.id === id) {
          render({ ...current, thumb: `data:image/png;base64,${b64}` }, SAVED_DISMISS_MS);
        }
      }
    } catch {
      // ignore — the pill is fully functional without a preview.
    }
  }, [deviceUdid, display, render, toastRef]);

  return { capture, reveal, dismiss };
}

/** Where the browser put a downloaded recording, or "" if it isn't there (yet). */
async function locateRecording(fileName: string): Promise<string> {
  try {
    const res = await hostAction("locateRecording", { fileName });
    return typeof res.path === "string" ? res.path : "";
  } catch {
    return "";
  }
}

const LOCATE_ATTEMPTS = 8;
const LOCATE_RETRY_MS = 500;

export interface RecordingToastOptions {
  /** Poster for the card (default: a frame from the MP4, decoded in the page). */
  thumbnail?: (blob: Blob) => Promise<string | undefined>;
  /** Host path of the downloaded file, "" if not found (default: host RPC). */
  locate?: (fileName: string) => Promise<string>;
  /** Wait between locate attempts while the browser finishes writing. */
  locateRetryMs?: number;
}

/**
 * The screenshot card for a recording the toolbar just downloaded: "Recording
 * Saved" / "Open in Finder" with a frame from the recording as its thumbnail.
 * The browser chose where the file went, so its host path is looked up by
 * name (a few tries while the download finishes; again on click if needed).
 * The card shows immediately; thumb and path fill in when they land.
 */
export function useRecordingToast({
  thumbnail = videoFrameThumbnail,
  locate = locateRecording,
  locateRetryMs = LOCATE_RETRY_MS,
}: RecordingToastOptions = {}) {
  const locateRef = useRef(locate);
  locateRef.current = locate;

  const { render, update, dismiss, reveal, toastRef } = useCaptureToast(RECORDING_TOAST_COPY, (t) => {
    if (t.path) {
      void hostAction("revealRecording", { path: t.path });
      return;
    }
    if (!t.fileName) return;
    const fileName = t.fileName;
    void locateRef.current(fileName).then((path) => {
      if (path) {
        update(t.id, { path });
        void hostAction("revealRecording", { path });
      } else {
        sonnerToast.error(`Couldn't find ${fileName}. Check your browser's downloads.`);
      }
    });
  });

  const show = useCallback(({ fileName, blob }: { fileName: string; blob: Blob }) => {
    const id = crypto.randomUUID();
    render({ id, status: "saved", phase: "in", fileName }, SAVED_DISMISS_MS);

    void thumbnail(blob)
      .then((thumb) => { if (thumb) update(id, { thumb }); })
      .catch(() => {});

    void (async () => {
      for (let attempt = 0; attempt < LOCATE_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, locateRetryMs));
        // Dismissed or replaced: the click path looks it up again if needed.
        if (toastRef.current?.id !== id) return;
        const path = await locateRef.current(fileName).catch(() => "");
        if (path) {
          update(id, { path });
          return;
        }
      }
    })();
  }, [locateRetryMs, render, thumbnail, toastRef, update]);

  return { show, reveal, dismiss };
}
