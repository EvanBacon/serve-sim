import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { simEndpoint } from "../utils/sim-endpoint";
import { recordingFileName } from "../../recording";

export type ScreenRecordingState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "recording"; startedAt: number }
  | { status: "saving" };

function recordingEndpoint(device: string, action?: "start" | "stop"): string {
  return simEndpoint(`helper/${encodeURIComponent(device)}/recording${action ? `/${action}` : ""}`);
}

/** `filename="…"` from a Content-Disposition header, if present. */
export function attachmentFileName(header: string | null): string | null {
  const match = header ? /filename="([^"]+)"/.exec(header) : null;
  return match?.[1] ?? null;
}

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { message?: string; error?: string } | null;
  return body?.message ?? body?.error ?? `HTTP ${res.status}`;
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a beat to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Start/stop a native screen recording on the server and download the MP4.
 * The server records at native resolution from the capture path, so this
 * works the same whether the viewer is on H.264 or MJPEG.
 */
export function useScreenRecording(device: string | null | undefined) {
  const [state, setState] = useState<ScreenRecordingState>({ status: "idle" });
  const deviceRef = useRef(device);
  deviceRef.current = device;

  // Pick up a recording already running on the server (page reload, second tab).
  useEffect(() => {
    setState({ status: "idle" });
    if (!device) return;
    let cancelled = false;
    void fetch(recordingEndpoint(device))
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { recording?: boolean; startedAt?: string } | null) => {
        if (cancelled || !body?.recording) return;
        const startedAt = body.startedAt ? Date.parse(body.startedAt) : Date.now();
        setState({ status: "recording", startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [device]);

  const start = useCallback(async () => {
    const udid = deviceRef.current;
    if (!udid) return;
    setState({ status: "starting" });
    try {
      const res = await fetch(recordingEndpoint(udid, "start"), { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      const body = await res.json() as { startedAt?: string };
      const startedAt = body.startedAt ? Date.parse(body.startedAt) : Date.now();
      setState({ status: "recording", startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() });
    } catch (error) {
      setState({ status: "idle" });
      toast.error(`Could not start recording: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const stop = useCallback(async () => {
    const udid = deviceRef.current;
    if (!udid) return;
    setState({ status: "saving" });
    try {
      const res = await fetch(recordingEndpoint(udid, "stop"), { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      const fileName = attachmentFileName(res.headers.get("content-disposition")) ?? recordingFileName();
      download(await res.blob(), fileName);
      toast.success(`Saved ${fileName}`);
    } catch (error) {
      toast.error(`Could not save recording: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setState({ status: "idle" });
    }
  }, []);

  const toggle = useCallback(() => {
    if (state.status === "idle") void start();
    else if (state.status === "recording") void stop();
  }, [state.status, start, stop]);

  return { state, start, stop, toggle };
}
