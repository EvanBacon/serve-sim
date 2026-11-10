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
import { fetchRecordingIndexText, RecordingIndexFetchError, type SavedRecording } from "./use-screen-recording";

/** A finished recording loaded into the timeline: its index + a playable URL. */
export type LoadedRecording = { source: TimelineSource; videoUrl: string; fileName: string };

/** `unknown` until the first `GET /buffer` answers; `unavailable` for errors/old servers. */
export type BufferStatus = "unknown" | "off" | "on" | "unavailable";

export type TimelineSourceKind = "recording" | "buffer";

/** How often the open timeline re-reads the buffer while following live. */
const BUFFER_POLL_MS = 1_000;
/** Slowest re-read while the buffer is unavailable (old server, errors). */
const BUFFER_POLL_MAX_MS = 30_000;

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
  onSavedConsumed,
  pollMs = BUFFER_POLL_MS,
}: {
  device: string | null | undefined;
  open: boolean;
  /** The latest indexed recording the toolbar saved; loaded once per token, while open. */
  saved?: SavedRecording | null;
  /** Called once `saved` has been tried (loaded or failed), so its blob can be released. */
  onSavedConsumed?: () => void;
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

  // Follow the buffer while open and live. Each read is scheduled after the
  // previous one answers (never overlapping, so a slow response can't land
  // after a newer one), and an unavailable buffer backs off to
  // BUFFER_POLL_MAX_MS instead of being asked every second.
  useEffect(() => {
    if (!open || !device || sourceKind !== "buffer" || scrubbing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = pollMs;
    const load = async () => {
      let available = true;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        try {
          const res = await fetch(bufferEndpoint(device));
          if (cancelled) return;
          if (!res.ok) {
            available = false;
            setBufferStatus("unavailable");
          } else {
            const body = await res.json() as { enabled?: boolean } & Parameters<typeof timelineFromBufferView>[0];
            if (cancelled) return;
            if (!body.enabled) {
              setBufferStatus("off");
              setBufferSource(null);
            } else {
              setBufferStatus("on");
              setBufferSource(timelineFromBufferView(body));
            }
          }
        } catch {
          if (cancelled) return;
          available = false;
          setBufferStatus("unavailable");
        }
      }
      delay = available ? pollMs : Math.min(Math.max(delay, pollMs) * 2, Math.max(pollMs, BUFFER_POLL_MAX_MS));
      timer = setTimeout(() => { void load(); }, delay);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
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
  // Only while open (reopening picks it up, since `saved` stays set), and
  // once per token: the token is marked handled only after an attempt
  // finishes, so a StrictMode re-run still loads it. `onSavedConsumed` lets
  // the owner drop its reference to the MP4 blob.
  const handledTokenRef = useRef<string | null>(null);
  const onSavedConsumedRef = useRef(onSavedConsumed);
  onSavedConsumedRef.current = onSavedConsumed;
  useEffect(() => {
    if (!open || !saved || saved.device !== device || handledTokenRef.current === saved.token) return;
    let cancelled = false;
    const finish = () => {
      handledTokenRef.current = saved.token;
      onSavedConsumedRef.current?.();
    };
    fetchRecordingIndexText(saved)
      .then((text) => {
        if (cancelled) return;
        finish();
        if (loadRecording(text, saved.blob, saved.fileName)) toast.message(`${saved.fileName} is on the timeline`);
      })
      .catch((error) => {
        if (cancelled) return;
        finish();
        if (error instanceof RecordingIndexFetchError && error.status === 404) {
          toast.message(`${saved.fileName} was saved; its timeline index has expired on the server. Open the .mp4 and .index.jsonl to scrub it.`);
        } else {
          toast.error(`Could not load the recording index: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    return () => { cancelled = true; };
  }, [open, saved, device, loadRecording]);

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
/** Buffer JPEGs fetched at once while dragging; later requests queue. */
const FRAME_FETCH_LIMIT = 3;

/**
 * Fetches buffer JPEGs into an LRU of blob URLs. Frame ids never change
 * content, so a fetch whose frame was scrubbed past is still cached (not
 * thrown away). At most `limit` run at once; a queued request whose caller
 * gave up before it started is dropped without fetching.
 * @lintignore Exported for tests.
 */
export function createBufferFrameLoader({ limit = FRAME_FETCH_LIMIT, cacheLimit = FRAME_CACHE_LIMIT } = {}) {
  const cache = new Map<string, string>();
  const inflight = new Map<string, Promise<string>>();
  const queue: Array<{ start: () => void; wanted: () => boolean; drop: () => void }> = [];
  let running = 0;
  let disposed = false;

  const pump = () => {
    while (running < limit && queue.length > 0) {
      const next = queue.shift()!;
      if (next.wanted()) next.start();
      else next.drop();
    }
  };
  const store = (key: string, url: string) => {
    cache.set(key, url);
    while (cache.size > cacheLimit) {
      const [oldKey, oldUrl] = cache.entries().next().value!;
      cache.delete(oldKey);
      URL.revokeObjectURL(oldUrl);
    }
  };

  return {
    /** Cached URL (marked most recent), if any. */
    peek(key: string): string | undefined {
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
      }
      return hit;
    },
    /** Blob URL for `key`; `wanted` is checked again before a queued fetch starts. */
    load(key: string, url: string, wanted: () => boolean): Promise<string> {
      const hit = this.peek(key);
      if (hit) return Promise.resolve(hit);
      const pending = inflight.get(key);
      if (pending) return pending;
      const promise = new Promise<string>((resolve, reject) => {
        queue.push({
          wanted,
          drop: () => {
            inflight.delete(key);
            reject(new Error("superseded"));
          },
          start: () => {
            running++;
            fetch(url)
              .then(async (res) => {
                if (!res.ok) throw new Error(String(res.status));
                const blobUrl = URL.createObjectURL(await res.blob());
                if (disposed) {
                  URL.revokeObjectURL(blobUrl);
                  throw new Error("disposed");
                }
                store(key, blobUrl);
                return blobUrl;
              })
              .then(resolve, reject)
              .finally(() => {
                inflight.delete(key);
                running--;
                pump();
              });
          },
        });
      });
      inflight.set(key, promise);
      pump();
      return promise;
    },
    dispose() {
      disposed = true;
      for (const entry of queue.splice(0)) entry.drop();
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    },
  };
}

/**
 * Blob URL of one buffer JPEG (`GET /buffer/frame?id=`), via a per-device
 * {@link createBufferFrameLoader}. Keeps the last good URL while the next
 * one loads, and reports `missing` when the buffer already evicted the frame.
 */
export function useBufferFrameUrl(device: string | null | undefined, frameId: number | null) {
  const [loader, setLoader] = useState<ReturnType<typeof createBufferFrameLoader> | null>(null);
  const [shown, setShown] = useState<{ url: string; frame: number } | null>(null);
  const [missing, setMissing] = useState(false);
  const wantedRef = useRef(frameId);
  wantedRef.current = frameId;

  useEffect(() => {
    if (!device) return;
    const next = createBufferFrameLoader();
    setLoader(next);
    return () => {
      next.dispose();
      setShown(null);
    };
  }, [device]);

  useEffect(() => {
    if (!device || !loader || frameId === null) return;
    const key = `${device}:${frameId}`;
    const hit = loader.peek(key);
    if (hit) {
      setShown({ url: hit, frame: frameId });
      setMissing(false);
      return;
    }
    let cancelled = false;
    loader.load(key, bufferEndpoint(device, "frame", `?id=${frameId}`), () => wantedRef.current === frameId)
      .then((url) => {
        if (cancelled) return;
        setShown({ url, frame: frameId });
        setMissing(false);
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof Error && (error.message === "superseded" || error.message === "disposed"))) return;
        setMissing(true);
      });
    return () => { cancelled = true; };
  }, [device, loader, frameId]);

  return { url: frameId === null ? null : shown?.url ?? null, shownFrame: shown?.frame ?? null, missing };
}
