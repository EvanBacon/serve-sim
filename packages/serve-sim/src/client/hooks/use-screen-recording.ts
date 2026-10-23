import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { simEndpoint } from "../utils/sim-endpoint";
import { recordingFileName } from "../../recording";

export type ScreenRecordingState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "recording"; startedAt: number }
  | { status: "saving" };

function recordingEndpoint(device: string, action?: "start" | "stop", token?: string): string {
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return simEndpoint(`helper/${encodeURIComponent(device)}/recording${action ? `/${action}` : ""}${query}`);
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

type RecordingStatusBody = { recording?: boolean; startedAt?: string; limitReached?: boolean };

/** How often the toolbar re-checks the server (other tabs, CLI, duration cap). */
export const RECORDING_STATUS_POLL_MS = 2_000;

function recordingState(startedAtIso: string | undefined): Extract<ScreenRecordingState, { status: "recording" }> {
  const startedAt = startedAtIso ? Date.parse(startedAtIso) : Date.now();
  return { status: "recording", startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() };
}

async function fetchRecordingStatus(device: string): Promise<RecordingStatusBody | null> {
  try {
    const res = await fetch(recordingEndpoint(device));
    return res.ok ? await res.json() as RecordingStatusBody : null;
  } catch {
    return null;
  }
}

/**
 * Start/stop a native screen recording on the server and download the MP4.
 * The server records at native resolution from the capture path, so this
 * works the same whether the viewer is on H.264 or MJPEG. The server is the
 * source of truth: its status is polled so recordings started or stopped
 * elsewhere (another tab, `serve-sim record`, the duration cap) show up here.
 */
export function useScreenRecording(
  device: string | null | undefined,
  { pollMs = RECORDING_STATUS_POLL_MS }: { pollMs?: number } = {},
) {
  const [state, setState] = useState<ScreenRecordingState>({ status: "idle" });
  // The device whose recording this hook drives; cleared on unmount/switch so
  // in-flight requests can tell their result is stale.
  const deviceRef = useRef<string | null | undefined>(undefined);
  // Bumped by every start/stop so a status read issued earlier can't clobber it.
  const epochRef = useRef(0);
  // Monotonic id per status poll: a slow response older than the latest is dropped.
  const pollIdRef = useRef(0);
  // Token from the start this hook made: only it may auto-collect at the cap.
  const ownedRef = useRef<{ device: string; token: string } | null>(null);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const stop = useCallback(async () => {
    const udid = deviceRef.current;
    if (!udid) return;
    epochRef.current++;
    const previous = stateRef.current;
    setState({ status: "saving" });
    const owned = ownedRef.current?.device === udid ? ownedRef.current.token : undefined;
    try {
      const res = await fetch(recordingEndpoint(udid, "stop", owned), { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      if (ownedRef.current?.token === owned) ownedRef.current = null;
      const fileName = attachmentFileName(res.headers.get("content-disposition")) ?? recordingFileName();
      download(await res.blob(), fileName);
      toast.success(`Saved ${fileName}`);
      if (deviceRef.current === udid) setState({ status: "idle" });
    } catch (error) {
      toast.error(`Could not save recording: ${error instanceof Error ? error.message : String(error)}`);
      // The stop may have failed while the recording is still running; ask
      // the server rather than assume. Unreachable server: keep what we had.
      const body = await fetchRecordingStatus(udid);
      if (deviceRef.current !== udid) return;
      if (!body) setState(previous.status === "saving" ? { status: "idle" } : previous);
      else setState(body.recording ? recordingState(body.startedAt) : { status: "idle" });
    }
  }, []);

  // Track the device and pick up a recording already running on the server
  // (page reload, second tab), then keep polling while idle or recording.
  useEffect(() => {
    deviceRef.current = device;
    setState({ status: "idle" });
    if (!device) return;
    let cancelled = false;
    const sync = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const epoch = epochRef.current;
      const pollId = ++pollIdRef.current;
      const body = await fetchRecordingStatus(device);
      if (cancelled || !body || epoch !== epochRef.current || pollId !== pollIdRef.current) return;
      const current = stateRef.current;
      // A start/stop in flight owns the state until it settles.
      if (current.status === "starting" || current.status === "saving") return;
      if (!body.recording) {
        if (ownedRef.current?.device === device) ownedRef.current = null;
        if (current.status !== "idle") setState({ status: "idle" });
        return;
      }
      if (body.limitReached && current.status === "recording" && ownedRef.current?.device === device) {
        // The server finalized our recording at its duration cap: collect it.
        // Other tabs (and the CLI's recordings) are left to their owner.
        toast.message("Recording reached the server's time limit; saving");
        void stop();
        return;
      }
      const next = recordingState(body.startedAt);
      if (current.status !== "recording" || current.startedAt !== next.startedAt) setState(next);
    };
    void sync();
    const timer = setInterval(() => { void sync(); }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (deviceRef.current === device) deviceRef.current = undefined;
    };
  }, [device, pollMs, stop]);

  const start = useCallback(async () => {
    const udid = deviceRef.current;
    if (!udid) return;
    epochRef.current++;
    setState({ status: "starting" });
    try {
      const res = await fetch(recordingEndpoint(udid, "start"), { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      const body = await res.json() as { startedAt?: string; token?: string };
      if (deviceRef.current !== udid) {
        // Unmounted or switched devices mid-start: don't orphan a recording
        // nobody can see. The server drops the file when we hang up.
        void fetch(recordingEndpoint(udid, "stop", body.token), { method: "POST" })
          .then((stopRes) => stopRes.body?.cancel())
          .catch(() => {});
        return;
      }
      ownedRef.current = body.token ? { device: udid, token: body.token } : null;
      setState(recordingState(body.startedAt));
    } catch (error) {
      toast.error(`Could not start recording: ${error instanceof Error ? error.message : String(error)}`);
      // e.g. 409: another tab or the CLI is already recording this device.
      const body = await fetchRecordingStatus(udid);
      if (deviceRef.current !== udid) return;
      setState(body?.recording ? recordingState(body.startedAt) : { status: "idle" });
    }
  }, []);

  const toggle = useCallback(() => {
    if (state.status === "idle") void start();
    else if (state.status === "recording") void stop();
  }, [state.status, start, stop]);

  return { state, start, stop, toggle };
}
