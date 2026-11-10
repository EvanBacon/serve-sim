/**
 * Recording index sidecar (`<name>.index.jsonl`): a line-per-record map of a
 * `serve-sim record` MP4 so agents can find "what changed when" without
 * decoding video.
 *
 * Lines (JSONL, one JSON object per line, in this order):
 *   {type:"header", version:1, file, fps, codec, width, height, rotation, clock, doc}
 *   {type:"frame", i, pts, uptime, changed}       one per sample in the MP4
 *   {type:"event", t, tEnd?, id, timestamp, kind, action?, summary, x?, y?, …}
 *   {type:"footer", frames, changedFrames, durationSec, events, eventsDropped, truncated}
 *
 * `clock` holds only numbers and ISO times; the prose explaining them is in
 * `doc`. `file` is a label (the MP4's name as the client saved it).
 *
 * JSONL rather than one JSON document: a 30 min 60 fps recording has ~108k
 * frame lines, which can be streamed by the server, appended to, and read with
 * `grep`/`jq -c`/line readers without holding the whole thing in memory.
 *
 * Clock join. The native recorder samples host uptime (`ScreenRecorder.now()`,
 * `DispatchTime.uptimeNanoseconds`: mach_absolute_time, not advancing during
 * sleep) and the wall clock (`Date()`) back to back when it is created:
 * `startUptime` / `startWall`. Their difference, `wallMinusUptimeSec`, is the
 * one offset used to move between the clocks for the whole recording (an NTP
 * step mid-recording would skew event times by the step; frame times are
 * unaffected). Media time 0 (pts 0) is the capture uptime of the first frame,
 * `originUptime`, so for any frame `pts ≈ uptime − originUptime` (snapped to the
 * fps grid; repeats carry their source frame's uptime). Event-log entries are
 * stamped with server wall-clock ISO times (ms precision) when the HID message
 * is handled, so their media time is
 *   t = (Date.parse(timestamp) / 1000 − wallMinusUptimeSec) − originUptime.
 * Events land before the frames they cause: the guest still has to render.
 *
 * Drags are one event from first move to end. `t` is when the drag started
 * (clamped to 0 when it began before the recording), `tEnd` when its last
 * point (`x`/`y`) was received (clamped to the duration when it was still
 * going at stop). A drag is kept when `[t, tEnd]` overlaps the recording.
 */
import type { EventLogEntry } from "./event-log";
import type { RecordingCodec } from "./native";

const RECORDING_INDEX_VERSION = 1;
export const RECORDING_INDEX_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
/** Recording-window events kept per recording (a drag is one event). */
const MAX_RECORDING_INDEX_EVENTS = 50_000;

/** The `index` object the native recorder adds to its finish summary. */
export type NativeRecordingIndex = {
  version: 1;
  fps: number;
  clock: { armedUptime: number; armedWallMs: number; originUptime?: number };
  /** Per appended sample: fps-grid slot (pts = slot / fps). */
  slots: number[];
  /** Per sample: capture uptime of the source frame, integer microseconds. */
  uptimesUs: number[];
  /** Per sample: 1 when its pixels differ from the previous sample's. */
  changed: number[];
  changedCount: number;
  /** The native collector hit its capacity; later samples are missing. */
  truncated: boolean;
};

export type RecordingClock = {
  startUptime: number;
  startWall: string;
  originUptime: number;
  originWall: string;
  wallMinusUptimeSec: number;
};

export type RecordingIndexSummary = {
  width?: number;
  height?: number;
  fps?: number;
  codec?: RecordingCodec;
  rotation?: number;
  duration?: number;
};

type Point = { x: number; y: number };

export type RecordingIndexEvent = {
  type: "event";
  /** Media seconds (same timeline as frame `pts`). */
  t: number;
  /** Drags: media seconds of the last point (`x`/`y`). */
  tEnd?: number;
  /** Event-log id (a drag keeps one id from first move to end). */
  id: number;
  /** Original event-log wall-clock timestamp. */
  timestamp: string;
  kind: string;
  action?: string;
  summary: string;
  /** Normalized (0..1) screen point: touch point, or a tap/drag's last point. */
  x?: number;
  y?: number;
  /** Drag start point (normalized). */
  start?: Point;
  dx?: number;
  dy?: number;
  edge?: number;
};

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNumberArray = (value: unknown): value is number[] => Array.isArray(value) && value.every(isFiniteNumber);

/** Validate the native `index` object; null when absent or malformed. */
function parseNativeRecordingIndex(value: unknown): NativeRecordingIndex | null {
  if (!value || typeof value !== "object") return null;
  const index = value as Partial<NativeRecordingIndex>;
  if (index.version !== RECORDING_INDEX_VERSION) return null;
  if (!isFiniteNumber(index.fps) || index.fps <= 0) return null;
  const clock = index.clock;
  if (!clock || !isFiniteNumber(clock.armedUptime) || !isFiniteNumber(clock.armedWallMs)) return null;
  if (clock.originUptime != null && !isFiniteNumber(clock.originUptime)) return null;
  if (!isNumberArray(index.slots) || !isNumberArray(index.uptimesUs) || !isNumberArray(index.changed)) return null;
  const n = index.slots.length;
  if (index.uptimesUs.length !== n || index.changed.length !== n) return null;
  return index as NativeRecordingIndex;
}

/**
 * Split the native finish summary into the summary proper and the index. The
 * index is stripped before the summary is sent as a response header, so that
 * header stays exactly what it was before indexes existed.
 */
export function splitRecordingSummary(raw: string): { summary: Record<string, unknown>; index: NativeRecordingIndex | null } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { summary: {}, index: null };
  }
  if (!parsed || typeof parsed !== "object") return { summary: {}, index: null };
  const { index, ...summary } = parsed;
  return { summary, index: parseNativeRecordingIndex(index) };
}

/** The clock join for `index`; null when no frame was placed (no pts 0). */
export function recordingClock(index: NativeRecordingIndex): RecordingClock | null {
  const { armedUptime, armedWallMs, originUptime } = index.clock;
  if (originUptime == null) return null;
  const wallMinusUptimeSec = armedWallMs / 1000 - armedUptime;
  return {
    startUptime: armedUptime,
    startWall: new Date(armedWallMs).toISOString(),
    originUptime,
    originWall: new Date(Math.round((originUptime + wallMinusUptimeSec) * 1000)).toISOString(),
    wallMinusUptimeSec,
  };
}

/** Media seconds for an ISO wall-clock timestamp; null when unparseable. */
function eventMediaTime(timestamp: string, clock: RecordingClock): number | null {
  const wallMs = Date.parse(timestamp);
  if (!Number.isFinite(wallMs)) return null;
  return wallMs / 1000 - clock.wallMinusUptimeSec - clock.originUptime;
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

function pointValue(value: unknown): Point | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y } = value as Record<string, unknown>;
  return isFiniteNumber(x) && isFiniteNumber(y) ? { x, y } : undefined;
}

/** A collected event-log entry and when its latest version was received. */
type CollectedEvent = { entry: EventLogEntry; receivedAtMs: number };

/**
 * Collected events → index event lines whose media time overlaps
 * `[0, durationSec]`, sorted by time. Input comes from
 * `RecordingEventCollector`, which already keeps only the device's HID input.
 */
export function recordingIndexEvents(
  collected: Iterable<CollectedEvent>,
  clock: RecordingClock,
  { durationSec }: { durationSec: number },
): RecordingIndexEvent[] {
  const events: RecordingIndexEvent[] = [];
  for (const { entry, receivedAtMs } of collected) {
    const start = eventMediaTime(entry.timestamp, clock);
    if (start == null) continue;
    const isDrag = entry.kind === "drag";
    // A drag spans first move → last update received; anything else is a point.
    const end = isDrag ? Math.max(start, receivedAtMs / 1000 - clock.wallMinusUptimeSec - clock.originUptime) : start;
    if (end < 0 || start > durationSec) continue;
    const event: RecordingIndexEvent = {
      type: "event",
      t: round6(Math.max(0, start)),
      ...(isDrag ? { tEnd: round6(Math.min(durationSec, end)) } : {}),
      id: entry.id,
      timestamp: entry.timestamp,
      kind: entry.kind,
      ...(entry.action != null ? { action: entry.action } : {}),
      summary: entry.summary,
    };
    const details = entry.details ?? {};
    const point = pointValue(details) ?? pointValue(details.current);
    if (point) Object.assign(event, point);
    const startPoint = isDrag ? pointValue(details.start) : undefined;
    if (startPoint) event.start = startPoint;
    if (isFiniteNumber(details.dx)) event.dx = details.dx;
    if (isFiniteNumber(details.dy)) event.dy = details.dy;
    if (isFiniteNumber(details.edge)) event.edge = details.edge;
    events.push(event);
  }
  return events.sort((a, b) => a.t - b.t || a.id - b.id);
}

/**
 * Collects a device's HID event-log entries while it records. The global
 * event log is a 500-entry ring, too small for a long recording, so the
 * session keeps its own copy. Updates (a drag growing) replace by id and
 * refresh the receive time. Once stopped it ignores further entries.
 */
export class RecordingEventCollector {
  private readonly byId = new Map<number, CollectedEvent>();
  private stopped = false;
  /** New events refused at the limit (reported as footer `eventsDropped`). */
  dropped = 0;

  constructor(
    private readonly device: string,
    private readonly limit = MAX_RECORDING_INDEX_EVENTS,
    private readonly now: () => number = Date.now,
  ) {}

  add(entry: EventLogEntry): void {
    if (this.stopped || entry.source !== "hid" || entry.device !== this.device) return;
    if (!this.byId.has(entry.id) && this.byId.size >= this.limit) {
      this.dropped++;
      return;
    }
    this.byId.set(entry.id, { entry, receivedAtMs: this.now() });
  }

  /** Stop collecting (the recording finalized). */
  stop(): void {
    this.stopped = true;
  }

  entries(): CollectedEvent[] {
    return [...this.byId.values()];
  }
}

/** Lines per yielded chunk: keeps a ~108k-frame index to ~100 writes. */
const LINES_PER_CHUNK = 1000;

/**
 * The sidecar as JSONL text chunks (each ends in "\n"), generated lazily so
 * the server can stream a long recording's index with backpressure.
 */
export function* recordingIndexLines({ file, summary, index, events, eventsDropped = 0 }: {
  file: string;
  summary: RecordingIndexSummary;
  index: NativeRecordingIndex;
  events: RecordingIndexEvent[];
  /** Events the collector refused at its limit: the event list is incomplete. */
  eventsDropped?: number;
}): Generator<string> {
  const clock = recordingClock(index);
  const fps = index.fps;
  yield JSON.stringify({
    type: "header",
    version: RECORDING_INDEX_VERSION,
    file,
    fps,
    codec: summary.codec ?? null,
    width: summary.width ?? null,
    height: summary.height ?? null,
    rotation: summary.rotation ?? 0,
    clock,
    doc: {
      uptimeClock: "host uptime seconds (DispatchTime.uptimeNanoseconds / mach_absolute_time; excludes sleep)",
      mediaTime: "pts = slot / fps; pts 0 is the frame captured at clock.originUptime",
      eventMapping: "t = (Date.parse(event.timestamp) / 1000 - clock.wallMinusUptimeSec) - clock.originUptime",
      drags: "t = drag start (clamped to 0), tEnd = when its last point x/y was received (clamped to the duration)",
    },
  }) + "\n";
  let chunk: string[] = [];
  let changedFrames = 0;
  for (let i = 0; i < index.slots.length; i++) {
    const changed = index.changed[i] === 1;
    if (changed) changedFrames++;
    chunk.push(JSON.stringify({
      type: "frame",
      i,
      pts: round6(index.slots[i]! / fps),
      uptime: round6(index.uptimesUs[i]! / 1e6),
      changed,
    }));
    if (chunk.length >= LINES_PER_CHUNK) {
      yield chunk.join("\n") + "\n";
      chunk = [];
    }
  }
  for (const event of events) chunk.push(JSON.stringify(event));
  chunk.push(JSON.stringify({
    type: "footer",
    frames: index.slots.length,
    changedFrames,
    durationSec: round6(summary.duration ?? 0),
    events: events.length,
    eventsDropped,
    truncated: index.truncated,
  }));
  yield chunk.join("\n") + "\n";
}

/** `rec.mp4` → `rec.index.jsonl` (other extensions are kept: `a.mov.index.jsonl`). */
export function recordingIndexPath(mp4Path: string): string {
  const match = /\.mp4$/i.exec(mp4Path);
  return `${match ? mp4Path.slice(0, match.index) : mp4Path}.index.jsonl`;
}
