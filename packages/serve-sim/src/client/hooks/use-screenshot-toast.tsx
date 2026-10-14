import { useCallback, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import { ScreenshotToast } from "../components/screenshot-toast";
import { hostAction } from "../utils/exec";

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
};

// How long the success pill lingers before auto-dismissing. Hovering pauses
// the timer, so this only needs to be long enough to notice the pill — not to
// read and act on it.
const SAVED_DISMISS_MS = 3500;
const ERROR_DISMISS_MS = 4000;

export function useScreenshotToast(deviceUdid?: string | null, display?: "primary" | "primary-1") {
  const toastRef = useRef<ScreenshotToast | null>(null);
  const toastIdRef = useRef<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissDeadlineRef = useRef<number | null>(null);
  const remainingDismissMsRef = useRef<number | null>(null);

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
    if (t?.path) void hostAction("revealScreenshot", { path: t.path });
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

  const render = useCallback((next: ScreenshotToast, duration = Infinity) => {
    toastRef.current = next;
    toastIdRef.current = next.id;
    sonnerToast.custom(
      (id) => (
        <ScreenshotToast
          toast={next}
          onReveal={reveal}
          onDismiss={() => dismiss(id)}
          onPause={pauseDismiss}
          onResume={resumeDismiss}
        />
      ),
      // This toast draws its own panel. Leave Sonner's chrome for plain toasts.
      { id: next.id, duration: Infinity, unstyled: true },
    );
    if (Number.isFinite(duration)) scheduleDismiss(duration);
    else {
      clearDismissTimer();
      remainingDismissMsRef.current = null;
    }
  }, [clearDismissTimer, dismiss, pauseDismiss, resumeDismiss, reveal, scheduleDismiss]);

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
  }, [deviceUdid, display, render]);

  return { capture, reveal, dismiss };
}
