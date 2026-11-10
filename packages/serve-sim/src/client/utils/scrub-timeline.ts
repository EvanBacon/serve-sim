/**
 * Pure model behind the scrub timeline: turns a finished recording's index
 * sidecar (#200) or a rolling-buffer view (#206) into one shape the UI can
 * seek, step, and draw markers on. No DOM, no fetches.
 *
 * Times are seconds on the source's own timeline: media time (frame `pts`)
 * for a recording, seconds since the oldest sample for the buffer. Both
 * sources already put their HID events on that same timeline.
 */
import type { ParsedRecordingIndex } from "../../recording-index-reader";
import type { BufferView } from "../../rolling-buffer";
import type { RecordingIndexEvent } from "../../recording-index";

/** One seekable position: a recording sample or a buffer sample. */
export type TimelineFrame = {
  t: number;
  /** Recording: sample index `i`. Buffer: frame id (repeats share an id). */
  frame: number;
  changed: boolean;
};

type TimelineMarkerKind = "tap" | "drag" | "other";

export type TimelineMarker = {
  id: number;
  t: number;
  /** Drags: time of the last point. */
  tEnd?: number;
  kind: TimelineMarkerKind;
  /** Event-log kind as recorded (`tap`, `drag`, `key`, `button`, ...). */
  rawKind: string;
  summary: string;
  /** Normalized (0..1) point: the tap, or a drag's last point. */
  x?: number;
  y?: number;
  /** Drag start (normalized). */
  start?: { x: number; y: number };
};

export type TimelineSource = {
  kind: "recording" | "buffer";
  /** Seconds the track spans, from 0. */
  duration: number;
  /** Ascending by `t`. */
  frames: TimelineFrame[];
  /** Ascending by `t`. */
  markers: TimelineMarker[];
  /** Recording: nominal fps, for mid-sample seeks. */
  fps?: number;
  /** Buffer: wall time of t = 0. */
  origin?: string;
};

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function markerKind(kind: string): TimelineMarkerKind {
  if (kind === "tap" || kind === "touch") return "tap";
  if (kind === "drag" || kind === "gesture" || kind === "multi-touch") return "drag";
  return "other";
}

function markerFromEvent(event: RecordingIndexEvent): TimelineMarker {
  return {
    id: event.id,
    t: event.t,
    ...(isFiniteNumber(event.tEnd) && event.tEnd > event.t ? { tEnd: event.tEnd } : {}),
    kind: markerKind(event.kind),
    rawKind: event.kind,
    summary: event.summary ?? event.kind,
    ...(isFiniteNumber(event.x) && isFiniteNumber(event.y) ? { x: event.x, y: event.y } : {}),
    ...(event.start && isFiniteNumber(event.start.x) && isFiniteNumber(event.start.y) ? { start: event.start } : {}),
  };
}

const byTime = (markers: TimelineMarker[]) => markers.sort((a, b) => a.t - b.t || a.id - b.id);

/** A finished recording's parsed sidecar → timeline source. */
export function timelineFromRecordingIndex(index: ParsedRecordingIndex): TimelineSource {
  const fps = index.header.fps;
  const frames = index.frames.map((f) => ({ t: f.pts, frame: f.i, changed: f.changed }));
  const footerDuration = index.footer?.durationSec;
  const last = frames.at(-1);
  const duration = isFiniteNumber(footerDuration) && footerDuration > 0
    ? footerDuration
    : last ? last.t + 1 / fps : 0;
  return {
    kind: "recording",
    duration,
    frames,
    markers: byTime(index.events.map(markerFromEvent)),
    fps,
  };
}

/** A `GET /buffer` view → timeline source; null when the buffer has no samples. */
export function timelineFromBufferView(view: Pick<BufferView, "origin" | "now" | "samples" | "events">): TimelineSource | null {
  if (!view.origin || view.samples.length === 0) return null;
  const frames = view.samples.map((s) => ({ t: s.t, frame: s.frame, changed: s.changed }));
  const nowSec = (Date.parse(view.now) - Date.parse(view.origin)) / 1000;
  const last = frames.at(-1)!;
  const duration = Math.max(last.t, isFiniteNumber(nowSec) ? nowSec : 0);
  return {
    kind: "buffer",
    duration,
    frames,
    markers: byTime((view.events ?? []).map(markerFromEvent)),
    origin: view.origin,
  };
}

/** Index of the last frame at or before `t` (the frame on screen at `t`); 0 before the first. -1 when empty. */
export function frameIndexAt(frames: readonly TimelineFrame[], t: number): number {
  if (frames.length === 0) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  if (t < frames[0]!.t) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.t <= t + 1e-9) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function clampTime(source: TimelineSource, t: number): number {
  if (!Number.isFinite(t)) return 0;
  return Math.min(Math.max(0, t), source.duration);
}

/**
 * Time of the frame `delta` samples from the one shown at `t`. Stepping
 * lands on frame times exactly, so a step always shows a new sample.
 */
export function stepFrame(source: TimelineSource, t: number, delta: number): number {
  const at = frameIndexAt(source.frames, t);
  if (at < 0) return clampTime(source, t);
  const next = Math.min(Math.max(0, at + delta), source.frames.length - 1);
  return source.frames[next]!.t;
}

/** The next (`dir` 1) or previous (`dir` -1) marker strictly past `t`; null at the end. */
export function adjacentMarker(source: TimelineSource, t: number, dir: 1 | -1): TimelineMarker | null {
  const eps = 1e-6;
  if (dir > 0) return source.markers.find((m) => m.t > t + eps) ?? null;
  for (let i = source.markers.length - 1; i >= 0; i--) {
    if (source.markers[i]!.t < t - eps) return source.markers[i]!;
  }
  return null;
}

/**
 * The marker "at" `t`: the latest one that started at most `window` seconds
 * before `t` (or is a drag still in progress at `t`). Drives the tap dot on
 * the shown frame.
 */
export function activeMarker(source: TimelineSource, t: number, window = 0.5): TimelineMarker | null {
  let found: TimelineMarker | null = null;
  for (const m of source.markers) {
    if (m.t > t + 1e-6) break;
    const end = m.tEnd ?? m.t;
    if (t - end <= window) found = m;
  }
  return found;
}

/**
 * Video time to request for the sample shown at `t`: the middle of that
 * sample, so the browser's decoder can't round back to the previous one
 * (the same fix `record frame` needed).
 */
export function recordingSeekTime(source: TimelineSource, t: number): number {
  const at = frameIndexAt(source.frames, t);
  if (at < 0) return clampTime(source, t);
  const frame = source.frames[at]!;
  const next = source.frames[at + 1]?.t ?? Math.min(source.duration, frame.t + 1 / (source.fps ?? 30));
  return frame.t + Math.max(0, next - frame.t) / 2;
}

/** `m:ss.cc` (hundredths), e.g. `0:03.25`. */
export function formatTimelineTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const hundredths = Math.round(safe * 100);
  const m = Math.floor(hundredths / 6000);
  const s = Math.floor((hundredths % 6000) / 100);
  const cs = hundredths % 100;
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** One-line description of a marker: kind, time, and where it landed. */
export function describeMarker(marker: TimelineMarker): string {
  const parts = [marker.rawKind, formatTimelineTime(marker.t)];
  if (marker.tEnd != null) parts[1] += `–${formatTimelineTime(marker.tEnd)}`;
  if (marker.start && marker.x != null && marker.y != null) {
    parts.push(`${pct(marker.start.x)}, ${pct(marker.start.y)} → ${pct(marker.x)}, ${pct(marker.y)}`);
  } else if (marker.x != null && marker.y != null) {
    parts.push(`at ${pct(marker.x)}, ${pct(marker.y)}`);
  }
  return parts.join(" · ");
}
