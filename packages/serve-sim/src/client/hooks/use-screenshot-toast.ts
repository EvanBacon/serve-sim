import { useCallback, useEffect, useRef, useState } from "react";
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
  const [toast, setToast] = useState<ScreenshotToast | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Duration of the active toast's timer, so a hover-pause can restart it with
  // the same budget when the cursor leaves.
  const dismissMs = useRef(SAVED_DISMISS_MS);
  // Mirror of `toast` for pause/resume, which run from event handlers and need
  // the current value without re-creating the callbacks on every render.
  const toastRef = useRef<ScreenshotToast | null>(null);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const clearTimer = () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
  };

  const startTimer = useCallback((id: string, ms: number) => {
    clearTimer();
    dismissMs.current = ms;
    dismissTimer.current = setTimeout(() => {
      // Hand off to the exit animation rather than yanking the node.
      setToast((t) => (t?.id === id ? { ...t, phase: "out" } : t));
    }, ms);
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setToast(null);
  }, []);

  // Pause while hovered; restart with a fresh budget when the cursor leaves.
  const pause = useCallback(() => {
    clearTimer();
  }, []);
  const resume = useCallback(() => {
    const t = toastRef.current;
    if (t && t.phase === "in" && t.status !== "saving") startTimer(t.id, dismissMs.current);
  }, [startTimer]);

  const reveal = useCallback(() => {
    const t = toastRef.current;
    if (t?.path) void execOnHost(`open -R ${shellEscape(t.path)}`);
  }, []);

  const capture = useCallback(async () => {
    if (!deviceUdid) return;
    clearTimer();
    const id = crypto.randomUUID();
    setToast({ id, status: "saving", phase: "in" });

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
        setToast({ id, status: "error", phase: "in", message: res.stderr.trim() || "Screenshot failed" });
        startTimer(id, ERROR_DISMISS_MS);
        return;
      }
    } catch (e) {
      setToast({
        id,
        status: "error",
        phase: "in",
        message: e instanceof Error ? e.message : "Screenshot failed",
      });
      startTimer(id, ERROR_DISMISS_MS);
      return;
    }

    setToast({ id, status: "saved", phase: "in", path });
    startTimer(id, SAVED_DISMISS_MS);

    // Best-effort thumbnail: downscale to a temp PNG, base64 it back, then
    // delete it. Failures (sips missing, etc.) just leave the placeholder.
    const thumb = `/tmp/serve-sim-screenshot-thumb-${id}.png`;
    try {
      const tr = await execOnHost(
        `sips -Z 320 ${shellEscape(path)} --out ${shellEscape(thumb)} >/dev/null 2>&1 && base64 -i ${shellEscape(thumb)}; rm -f ${shellEscape(thumb)}`,
      );
      const b64 = tr.stdout.replace(/\s+/g, "");
      if (b64) {
        setToast((t) =>
          t?.id === id ? { ...t, thumb: `data:image/png;base64,${b64}` } : t,
        );
      }
    } catch {
      // ignore — the pill is fully functional without a preview.
    }
  }, [deviceUdid, startTimer]);

  return { toast, capture, reveal, dismiss, pause, resume };
}
