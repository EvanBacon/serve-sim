import { useCallback, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import { ScreenshotToast } from "../components/screenshot-toast";
import { execOnHost, shellEscape } from "../utils/exec";

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

function timestampSlug(): string {
  // 2026-06-11T14-12-44-123 — filesystem-safe, sorts chronologically. Keep the
  // milliseconds so two captures in the same second don't clobber one file.
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
}

export function useScreenshotToast(deviceUdid?: string | null) {
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
    if (t?.path) void execOnHost(`open -R ${shellEscape(t.path)}`);
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
      { id: next.id, duration: Infinity },
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

    // Resolve $HOME shell-side so the saved path comes back absolute — a "~"
    // path would survive shellEscape() as a literal tilde and break the later
    // `open -R`. The command echoes the path it wrote on success.
    const file = `$HOME/Desktop/serve-sim-screenshot-${timestampSlug()}.png`;
    const capCmd =
      `F="${file}"; xcrun simctl io ${shellEscape(deviceUdid)} screenshot "$F" && printf '%s' "$F"`;

    let path: string;
    try {
      const res = await execOnHost(capCmd);
      path = res.stdout.trim();
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

    // Best-effort thumbnail: downscale to a temp PNG, base64 it back, then
    // delete it. Failures (sips missing, etc.) just leave the placeholder.
    const thumb = `/tmp/serve-sim-screenshot-thumb-${id}.png`;
    try {
      const tr = await execOnHost(
        `sips -Z 320 ${shellEscape(path)} --out ${shellEscape(thumb)} >/dev/null 2>&1 && base64 -i ${shellEscape(thumb)}; rm -f ${shellEscape(thumb)}`,
      );
      const b64 = tr.stdout.replace(/\s+/g, "");
      if (b64) {
        const current = toastRef.current;
        if (current?.id === id) {
          render({ ...current, thumb: `data:image/png;base64,${b64}` }, SAVED_DISMISS_MS);
        }
      }
    } catch {
      // ignore — the pill is fully functional without a preview.
    }
  }, [deviceUdid, render]);

  return { capture, reveal, dismiss };
}
