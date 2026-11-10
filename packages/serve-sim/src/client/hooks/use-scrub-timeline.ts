import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { parseRecordingIndex } from "../../recording-index-reader";
import { simEndpoint } from "../utils/sim-endpoint";
import {
  clampTime,
  timelineFromBufferView,
  timelineFromRecordingIndex,
  type TimelineSource,
} from "../utils/scrub-timeline";
import { fetchRecordingIndexText, type SavedRecording } from "./use-screen-recording";

/** A finished recording loaded into the timeline: its index + a playable URL. */
export type LoadedRecording = { source: TimelineSource; videoUrl: string; fileName: string };

/** `unknown` until the first `GET /buffer` answers; `unavailable` for errors/old servers. */
export type BufferStatus = "unknown" | "off" | "on" | "unavailable";

export type TimelineSourceKind = "recording" | "buffer";

/** How often the open timeline re-reads the buffer while following live. */
const BUFFER_POLL_MS = 1_000;

function bufferEndpoint(device: string, action?: "start" | "frame", query = ""): string {
  return simEndpoint(`helper/${encodeURIComponent(device)}/buffer${action ? `/${action}` : ""}${query}`);
}

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { message?: string; error?: string } | null;
  return body?.message ?? body?.error ?? `HTTP ${res.status}`;
}

const isVideoFile = (file: File) => file.type.startsWith("video/") || /\.(mp4|mov|m4v)$/i.test(file.name);
const isIndexFile = (file: File) => /\.jsonl$/i.test(file.name);

/**
 * State behind the scrub timeline. Nothing runs while `open` is false (no
 * polling, no fetches), so the live stream, recorder, and buffer behave
 * exactly as without it.
 *
 * - Buffer source: polls `GET /buffer` while following live; freezes the
 *   view while scrubbing so frame ids stay valid.
 * - Recording source: a sidecar parsed with the same reader `record
 *   frame|diff|changes` uses, plus a blob URL of the MP4 (the one the
 *   browser just downloaded, or files the user picked).
 * - `position` null = live (no overlay); a number = seconds on the source.
 */
export function useScrubTimeline({
  device,
  open,
  saved,
  pollMs = BUFFER_POLL_MS,
}: {
  device: string | null | undefined;
  open: boolean;
  /** The latest indexed recording the toolbar saved; loaded when it changes. */
  saved?: SavedRecording | null;
  pollMs?: number;
}) {
  const [recording, setRecordingState] = useState<LoadedRecording | null>(null);
  const [bufferStatus, setBufferStatus] = useState<BufferStatus>("unknown");
  const [bufferSource, setBufferSource] = useState<TimelineSource | null>(null);
  const [sourceKind, setSourceKind] = useState<TimelineSourceKind>("buffer");
  const [position, setPositionState] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  const source = sourceKind === "recording" ? recording?.source ?? null : bufferSource;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const scrubbing = position !== null;
  // A seek made while buffer playback runs; the playback loop adopts it.
  const seekedRef = useRef<number | null>(null);

  const setRecording = useCallback((next: LoadedRecording | null) => {
    setRecordingState((prev) => {
      if (prev && prev.videoUrl !== next?.videoUrl) URL.revokeObjectURL(prev.videoUrl);
      return next;
    });
  }, []);

  // Another device: nothing carries over.
  useEffect(() => {
    setRecording(null);
    setBufferSource(null);
    setBufferStatus("unknown");
    setSourceKind("buffer");
    setPositionState(null);
    setPlaying(false);
  }, [device, setRecording]);
  // Release the last blob URL on unmount.
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  useEffect(() => () => {
    if (recordingRef.current) URL.revokeObjectURL(recordingRef.current.videoUrl);
  }, []);

  // Closing the timeline returns to live.
  useEffect(() => {
    if (open) return;
    setPositionState(null);
    setPlaying(false);
  }, [open]);

  // Follow the buffer while open and live.
  useEffect(() => {
    if (!open || !device || sourceKind !== "buffer" || scrubbing) return;
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const res = await fetch(bufferEndpoint(device));
        if (cancelled) return;
        if (!res.ok) { setBufferStatus("unavailable"); return; }
        const body = await res.json() as { enabled?: boolean } & Parameters<typeof timelineFromBufferView>[0];
        if (cancelled) return;
        if (!body.enabled) {
          setBufferStatus("off");
          setBufferSource(null);
          return;
        }
        setBufferStatus("on");
        setBufferSource(timelineFromBufferView(body));
      } catch {
        if (!cancelled) setBufferStatus("unavailable");
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, device, sourceKind, scrubbing, pollMs]);

  const loadRecording = useCallback((text: string, blob: Blob, fileName: string): boolean => {
    let source: TimelineSource;
    try {
      source = timelineFromRecordingIndex(parseRecordingIndex(text, fileName.replace(/\.[^.]+$/, ".index.jsonl")));
    } catch (error) {
      toast.error(`Could not read the recording index: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (source.frames.length === 0) {
      toast.error("The recording index has no frames");
      return false;
    }
    setRecording({ source, videoUrl: URL.createObjectURL(blob), fileName });
    setSourceKind("recording");
    setPositionState(null);
    setPlaying(false);
    return true;
  }, [setRecording]);

  // A recording the toolbar just saved: fetch its sidecar from the server.
  useEffect(() => {
    if (!saved || saved.device !== device) return;
    let cancelled = false;
    fetchRecordingIndexText(saved)
      .then((text) => {
        if (!cancelled && loadRecording(text, saved.blob, saved.fileName)) {
          toast.message(`${saved.fileName} is on the timeline`);
        }
      })
      .catch((error) => {
        if (!cancelled) toast.error(`Could not load the recording index: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => { cancelled = true; };
  }, [saved, device, loadRecording]);

  /** An MP4 + its `.index.jsonl` picked from disk (e.g. from `serve-sim record`). */
  const openFiles = useCallback(async (files: Iterable<File>): Promise<boolean> => {
    const list = [...files];
    const video = list.find(isVideoFile);
    const index = list.find(isIndexFile);
    if (!video || !index) {
      toast.error(video
        ? "Choose the recording's .index.jsonl too (serve-sim record writes it next to the MP4)"
        : "Choose the recording's .mp4 and its .index.jsonl");
      return false;
    }
    return loadRecording(await index.text(), video, video.name);
  }, [loadRecording]);

  const closeRecording = useCallback(() => {
    setRecording(null);
    setSourceKind("buffer");
    setPositionState(null);
    setPlaying(false);
  }, [setRecording]);

  const selectSource = useCallback((kind: TimelineSourceKind) => {
    setSourceKind(kind);
    setPositionState(null);
    setPlaying(false);
  }, []);

  const startBuffer = useCallback(async () => {
    if (!device) return;
    try {
      const res = await fetch(bufferEndpoint(device, "start"), { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      setBufferStatus("on");
    } catch (error) {
      toast.error(`Could not start the buffer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [device]);

  /** Seek (clamped to the source); null returns to live. */
  const seek = useCallback((t: number | null) => {
    const current = sourceRef.current;
    if (t === null || !current) {
      setPositionState(null);
      setPlaying(false);
      return;
    }
    const clamped = clampTime(current, t);
    seekedRef.current = clamped;
    setPositionState(clamped);
  }, []);

  const playingRef = useRef(playing);
  playingRef.current = playing;
  const positionRef = useRef(position);
  positionRef.current = position;

  const togglePlaying = useCallback(() => {
    const current = sourceRef.current;
    if (!current) return;
    if (playingRef.current) {
      setPlaying(false);
      return;
    }
    // From live or the end, play from the start.
    const p = positionRef.current;
    if (p === null || p >= current.duration - 1e-3) setPositionState(0);
    setPlaying(true);
  }, []);

  // Buffer playback: advance on animation frames at 1x. (A recording plays
  // through its <video>, which reports its time back via `seek`.)
  useEffect(() => {
    if (!playing || sourceKind !== "buffer" || !source) return;
    let raf = 0;
    let last = performance.now();
    let at = positionRef.current ?? 0;
    seekedRef.current = null;
    const tick = (now: number) => {
      if (seekedRef.current !== null) {
        at = seekedRef.current;
        seekedRef.current = null;
      }
      at += Math.max(0, now - last) / 1000;
      last = now;
      if (at >= source.duration) {
        setPositionState(source.duration);
        setPlaying(false);
        return;
      }
      setPositionState(at);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, sourceKind, source]);

  return {
    source,
    sourceKind,
    recording,
    bufferStatus,
    hasBuffer: bufferSource !== null,
    position,
    playing,
    seek,
    setPlaying,
    togglePlaying,
    selectSource,
    startBuffer,
    openFiles,
    closeRecording,
  };
}

const FRAME_CACHE_LIMIT = 120;

/**
 * Blob URL of one buffer JPEG (`GET /buffer/frame?id=`). Frame ids never
 * change content, so fetched frames are cached (LRU) for back-and-forth
 * scrubbing. Keeps the last good URL while the next one loads, and reports
 * `missing` when the buffer already evicted the frame.
 */
export function useBufferFrameUrl(device: string | null | undefined, frameId: number | null) {
  const cacheRef = useRef(new Map<string, string>());
  const [shown, setShown] = useState<{ url: string; frame: number } | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, [device]);

  useEffect(() => {
    if (!device || frameId === null) return;
    const key = `${device}:${frameId}`;
    const cache = cacheRef.current;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      setShown({ url: hit, frame: frameId });
      setMissing(false);
      return;
    }
    let cancelled = false;
    fetch(bufferEndpoint(device, "frame", `?id=${frameId}`))
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const url = URL.createObjectURL(await res.blob());
        if (cancelled) { URL.revokeObjectURL(url); return; }
        cache.set(key, url);
        while (cache.size > FRAME_CACHE_LIMIT) {
          const [oldKey, oldUrl] = cache.entries().next().value!;
          cache.delete(oldKey);
          URL.revokeObjectURL(oldUrl);
        }
        setShown({ url, frame: frameId });
        setMissing(false);
      })
      .catch(() => { if (!cancelled) setMissing(true); });
    return () => { cancelled = true; };
  }, [device, frameId]);

  return { url: frameId === null ? null : shown?.url ?? null, shownFrame: shown?.frame ?? null, missing };
}
