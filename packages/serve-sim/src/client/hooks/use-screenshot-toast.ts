import { useCallback, useRef, useState } from "react";
import { execOnHost, shellEscape } from "../utils/exec";

export type ScreenshotToast = {
  id: string;
  status: "saving" | "saved" | "error";
  // Absolute path on the host once the capture lands; used by "Open in Finder".
  path?: string;
  // data: URL of a downscaled preview, filled in best-effort after the save.
  thumb?: string;
  message?: string;
};

// How long the success pill lingers before auto-dismissing. Long enough to
// give the user a chance to click "Open in Finder" without it nagging forever.
const SAVED_DISMISS_MS = 6000;
const ERROR_DISMISS_MS = 4000;

function timestampSlug(): string {
  // 2026-06-11T14-12-44 — filesystem-safe, sorts chronologically.
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function useScreenshotToast(deviceUdid?: string | null) {
  const [toast, setToast] = useState<ScreenshotToast | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
  };

  const dismiss = useCallback(() => {
    clearTimer();
    setToast(null);
  }, []);

  const scheduleDismiss = useCallback((id: string, ms: number) => {
    clearTimer();
    dismissTimer.current = setTimeout(() => {
      setToast((t) => (t?.id === id ? null : t));
    }, ms);
  }, []);

  const reveal = useCallback(() => {
    setToast((t) => {
      if (t?.path) void execOnHost(`open -R ${shellEscape(t.path)}`);
      return t;
    });
  }, []);

  const capture = useCallback(async () => {
    if (!deviceUdid) return;
    clearTimer();
    const id = crypto.randomUUID();
    setToast({ id, status: "saving" });

    // Resolve $HOME shell-side so the saved path comes back absolute — a "~"
    // path would survive shellEscape() as a literal tilde and break the later
    // `open -R`. The command echoes the path it wrote on success.
    const file = `$HOME/Desktop/serve-sim-screenshot-${timestampSlug()}.png`;
    const capCmd =
      `F="${file}"; xcrun simctl io ${deviceUdid} screenshot "$F" && printf '%s' "$F"`;

    let path: string;
    try {
      const res = await execOnHost(capCmd);
      path = res.stdout.trim();
      if (res.exitCode !== 0 || !path) {
        setToast({ id, status: "error", message: res.stderr.trim() || "Screenshot failed" });
        scheduleDismiss(id, ERROR_DISMISS_MS);
        return;
      }
    } catch (e) {
      setToast({
        id,
        status: "error",
        message: e instanceof Error ? e.message : "Screenshot failed",
      });
      scheduleDismiss(id, ERROR_DISMISS_MS);
      return;
    }

    setToast({ id, status: "saved", path });
    scheduleDismiss(id, SAVED_DISMISS_MS);

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
  }, [deviceUdid, scheduleDismiss]);

  return { toast, capture, reveal, dismiss };
}
