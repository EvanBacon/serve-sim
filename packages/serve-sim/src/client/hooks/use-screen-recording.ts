import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { simEndpoint } from "../utils/sim-endpoint";
import { recordingFileName } from "../../recording";

export type ScreenRecordingState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "recording"; startedAt: number }
  | { status: "saving" };

function recordingEndpoint(device: string, action?: "start" | "stop" | "index", params: Record<string, string | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value != null) search.set(key, value);
  const encoded = search.toString();
  const query = encoded ? `?${encoded}` : "";
  return simEndpoint(`helper/${encodeURIComponent(device)}/recording${action ? `/${action}` : ""}${query}`);
}

/** A recording this hook started with `index` on, once its MP4 has downloaded. */
export type SavedRecording = {
  device: string;
  /** The start token: `GET /recording/index?token=` serves its sidecar. */
  token: string;
  fileName: string;
  blob: Blob;
};

/** A failed `GET /recording/index`; `status` 404 means the sidecar is gone. */
export class RecordingIndexFetchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** `GET /recording/index` for a saved recording → sidecar text. */
export async function fetchRecordingIndexText(saved: Pick<SavedRecording, "device" | "token" | "fileName">): Promise<string> {
  const res = await fetch(recordingEndpoint(saved.device, "index", { token: saved.token, file: saved.fileName }));
  if (!res.ok) throw new RecordingIndexFetchError(await errorMessage(res), res.status);
  return res.text();
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
  {
    pollMs = RECORDING_STATUS_POLL_MS,
    index = false,
    onSaved,
  }: {
    pollMs?: number;
    /**
     * Ask the server to index starts made while this is true (`index=1`:
     * frame/event sidecar, as `serve-sim record` does). Off by default, so
     * the recorder is unchanged unless the scrub timeline wants it.
     */
    index?: boolean;
    /** Called after an indexed recording this hook started is downloaded. */
    onSaved?: (saved: SavedRecording) => void;
  } = {},
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
  const ownedRef = useRef<{ device: string; token: string; indexed: boolean } | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const stop = useCallback(async () => {
    const udid = deviceRef.current;
    if (!udid) return;
    epochRef.current++;
    const previous = stateRef.current;
    setState({ status: "saving" });
    const ownedRecording = ownedRef.current?.device === udid ? ownedRef.current : null;
    const owned = ownedRecording?.token;
    try {
      const res = await fetch(recordingEndpoint(udid, "stop", { token: owned }), { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      if (ownedRef.current?.token === owned) ownedRef.current = null;
      const fileName = attachmentFileName(res.headers.get("content-disposition")) ?? recordingFileName();
      const blob = await res.blob();
      download(blob, fileName);
      toast.success(`Saved ${fileName}`);
      if (ownedRecording?.indexed) onSavedRef.current?.({ device: udid, token: ownedRecording.token, fileName, blob });
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
      const indexed = indexRef.current;
      const res = await fetch(recordingEndpoint(udid, "start", { index: indexed ? "1" : undefined }), { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      const body = await res.json() as { startedAt?: string; token?: string };
      if (deviceRef.current !== udid) {
        // Unmounted or switched devices mid-start: don't orphan a recording
        // nobody can see. The server drops the file when we hang up.
        void fetch(recordingEndpoint(udid, "stop", { token: body.token }), { method: "POST" })
          .then((stopRes) => stopRes.body?.cancel())
          .catch(() => {});
        return;
      }
      ownedRef.current = body.token ? { device: udid, token: body.token, indexed } : null;
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
