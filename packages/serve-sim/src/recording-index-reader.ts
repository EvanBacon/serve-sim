/**
 * Reading a finished recording's `<name>.index.jsonl` sidecar (written by
 * `serve-sim record`, schema in ./recording-index.ts) for the offline
 * `serve-sim record frame|diff|changes` commands. Pure: no decoding, no
 * server.
 */
import { readFileSync } from "fs";
import type { RecordingClock, RecordingIndexEvent } from "./recording-index";

const SUPPORTED_VERSION = 1;
/** Default seconds an event may sit from a changed frame to count as near it. */
const DEFAULT_NEAR_SEC = 0.5;

export class RecordingIndexError extends Error {
  /** The sidecar file does not exist (as opposed to being malformed). */
  readonly missing: boolean;
  constructor(message: string, missing = false) {
    super(message);
    this.name = "RecordingIndexError";
    this.missing = missing;
  }
}

type RecordingIndexHeader = {
  type: "header";
  version: number;
  file?: string;
  fps: number;
  codec?: string | null;
  width?: number | null;
  height?: number | null;
  rotation?: number;
  clock: RecordingClock | null;
};

/** A sample as the inspect commands use it (`uptime` dropped). */
type IndexFrame = { i: number; pts: number; changed: boolean };

type RecordingIndexFooter = {
  type: "footer";
  frames?: number;
  changedFrames?: number;
  durationSec?: number;
  events?: number;
  eventsDropped?: number;
  truncated?: boolean;
};

export type ParsedRecordingIndex = {
  header: RecordingIndexHeader;
  frames: IndexFrame[];
  events: RecordingIndexEvent[];
  /** Null when the file was cut short before its footer. */
  footer: RecordingIndexFooter | null;
};

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Parse sidecar text; `label` (usually the path) prefixes error messages.
 * Also used by the web UI's scrub timeline (no `fs`: the browser bundle
 * stubs it, and only `readRecordingIndex` touches it).
 */
export function parseRecordingIndex(text: string, label: string): ParsedRecordingIndex {
  let header: RecordingIndexHeader | null = null;
  const frames: IndexFrame[] = [];
  const events: RecordingIndexEvent[] = [];
  let footer: RecordingIndexFooter | null = null;
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.trim();
    if (line === "") continue;
    const where = `${label}:${n + 1}`;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new RecordingIndexError(`${where}: not valid JSON`);
    }
    if (!record || typeof record !== "object") throw new RecordingIndexError(`${where}: not a JSON object`);
    if (!header) {
      if (record.type !== "header") {
        throw new RecordingIndexError(`${where}: first line must be the header, got ${JSON.stringify(record.type)}`);
      }
      if (record.version !== SUPPORTED_VERSION) {
        throw new RecordingIndexError(`${where}: unsupported recording index version ${String(record.version)} (expected ${SUPPORTED_VERSION})`);
      }
      if (!isFiniteNumber(record.fps) || record.fps <= 0) throw new RecordingIndexError(`${where}: header fps must be a positive number`);
      header = record as RecordingIndexHeader;
      continue;
    }
    switch (record.type) {
      case "frame": {
        const { i, pts, changed } = record;
        if (!isFiniteNumber(i) || !isFiniteNumber(pts) || typeof changed !== "boolean") {
          throw new RecordingIndexError(`${where}: malformed frame line (needs numeric i/pts and boolean changed)`);
        }
        frames.push({ i, pts, changed });
        break;
      }
      case "event":
        if (!isFiniteNumber(record.t)) throw new RecordingIndexError(`${where}: malformed event line (needs numeric t)`);
        events.push(record as RecordingIndexEvent);
        break;
      case "footer":
        footer = record as RecordingIndexFooter;
        break;
      default:
        // Unknown line types are skipped so newer writers stay readable.
        break;
    }
  }
  if (!header) throw new RecordingIndexError(`${label}: empty recording index`);
  frames.sort((a, b) => a.pts - b.pts || a.i - b.i);
  events.sort((a, b) => a.t - b.t || a.id - b.id);
  return { header, frames, events, footer };
}

/** Read and parse a sidecar; a missing file throws with `missing: true`. */
export function readRecordingIndex(path: string): ParsedRecordingIndex {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new RecordingIndexError(`No recording index at ${path}`, true);
    throw new RecordingIndexError(`Could not read ${path}: ${(error as Error).message}`);
  }
  return parseRecordingIndex(text, path);
}

/** Index into ascending `times` of the entry nearest `t`; ties go earlier. -1 when empty. */
export function nearestIndex(times: ArrayLike<number>, t: number): number {
  if (times.length === 0) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  // lo: first time >= t (or the last). Compare with its predecessor.
  if (lo > 0 && t - times[lo - 1]! <= times[lo]! - t + 1e-9) return lo - 1;
  return lo;
}

/** Media duration: the footer's, else the last frame's pts plus one frame. */
export function recordingDuration(index: ParsedRecordingIndex): number {
  if (isFiniteNumber(index.footer?.durationSec)) return index.footer.durationSec;
  const last = index.frames.at(-1);
  return last ? last.pts + 1 / index.header.fps : 0;
}

type ChangeEvent = RecordingIndexEvent & {
  /** First changed frame at or after the event (within `near` of its end), if any. */
  nextChange: { i: number; pts: number } | null;
};

export type RecordingChanges = {
  file: string | null;
  fps: number;
  durationSec: number;
  clock: RecordingClock | null;
  window: { from: number; to: number };
  /** The sidecar ended with its footer (false: the file was cut short). */
  complete: boolean;
  /** The writer hit its frame cap: frames after the last listed one are missing. */
  truncated: boolean;
  /** HID events the writer dropped (over its cap). */
  eventsDropped: number;
  changedFrames: number;
  frames: { i: number; pts: number }[];
  events: ChangeEvent[];
  /** Events in the window with no changed frame within `near` (e.g. a missed tap). */
  unmatchedEvents: RecordingIndexEvent[];
};

/**
 * Changed frames in `[from, to]` and the HID events near them: an event is
 * kept when it overlaps `[from − near, to]` (an input just before the window
 * can cause its changes) and some changed frame in the window lies within
 * `near` seconds of `[t, tEnd ?? t]`. Events in the window that fail the
 * second test go to `unmatchedEvents`.
 */
export function recordingChanges(
  index: ParsedRecordingIndex,
  { from, to, near = DEFAULT_NEAR_SEC }: { from?: number; to?: number; near?: number },
): RecordingChanges {
  const durationSec = recordingDuration(index);
  const start = from ?? 0;
  const end = to ?? durationSec;
  if (start > end) throw new RecordingIndexError(`--from ${start} is after --to ${end}`);
  const changed = index.frames.filter((f) => f.changed && f.pts >= start && f.pts <= end);
  const times = changed.map((f) => f.pts);
  const events: ChangeEvent[] = [];
  const unmatchedEvents: RecordingIndexEvent[] = [];
  for (const event of index.events) {
    const t = event.t;
    const tEnd = event.tEnd ?? t;
    if (tEnd < start - near || t > end) continue;
    // The first changed frame at or after t − near must be within near of tEnd.
    const k = lowerBound(times, t - near);
    if (k >= times.length || times[k]! > tEnd + near) {
      unmatchedEvents.push(event);
      continue;
    }
    const firstAfter = lowerBound(times, t);
    const next = firstAfter < times.length && times[firstAfter]! <= tEnd + near ? changed[firstAfter]! : null;
    events.push({ ...event, nextChange: next ? { i: next.i, pts: next.pts } : null });
  }
  return {
    file: index.header.file ?? null,
    fps: index.header.fps,
    durationSec,
    clock: index.header.clock ?? null,
    window: { from: start, to: end },
    complete: index.footer !== null,
    truncated: index.footer?.truncated === true,
    eventsDropped: index.footer?.eventsDropped ?? 0,
    changedFrames: changed.length,
    frames: changed.map(({ i, pts }) => ({ i, pts })),
    events,
    unmatchedEvents,
  };
}

/** First index with `times[k] >= t` (times ascending). */
function lowerBound(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t - 1e-9) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
