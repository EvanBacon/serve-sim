/**
 * `serve-sim record frame|diff|changes`: inspect a finished recording offline
 * (a local MP4 plus its `<name>.index.jsonl` sidecar) so an agent can see
 * what changed when without opening the video.
 *
 * - frame:   the sample nearest a time, as a PNG
 * - diff:    two samples' pixel difference, as a highlight PNG + bbox
 * - changes: changed frames and nearby HID events, from the sidecar only
 *
 * Decoding goes through the native addon (AVFoundation); everything else here
 * is pure and takes its I/O as `deps` so it can be tested without video.
 */
import { existsSync, writeFileSync } from "fs";
import { basename, dirname, extname, join } from "path";
import { DEFAULT_DIFF_THRESHOLD, diffFrames, encodePng, renderDiffImage } from "./frame-image";
import type { VideoFrame, VideoInfo } from "./native";
import { recordingIndexPath } from "./recording-index";
import {
  RecordingIndexError,
  nearestIndex,
  readRecordingIndex,
  recordingChanges,
  recordingDuration,
  type ParsedRecordingIndex,
} from "./recording-index-reader";

export const RECORD_INSPECT_VERBS = ["frame", "diff", "changes"] as const;
type RecordInspectVerb = (typeof RECORD_INSPECT_VERBS)[number];

type FrameArgs = { verb: "frame"; mp4: string; t: number; output?: string; index?: string };
type DiffArgs = { verb: "diff"; mp4: string; from: number; to: number; output?: string; index?: string; threshold?: number };
type ChangesArgs = { verb: "changes"; mp4: string; from?: number; to?: number; near?: number; index?: string };
type RecordInspectArgs = FrameArgs | DiffArgs | ChangesArgs | { verb: RecordInspectVerb; help: true };

const RECORD_INSPECT_USAGE: Record<RecordInspectVerb, string> = {
  frame: `Usage: serve-sim record frame <mp4> -t <seconds> [-o out.png|-] [--index <sidecar>]

Write the sample nearest <seconds> as a PNG (default <mp4-stem>-t<seconds>.png
next to the MP4; -o - writes the PNG to stdout and the JSON to stderr). Prints
{"i","pts","decodedPts","changed"?,"path","width","height"}. Uses the sidecar's frame times
when <mp4-stem>.index.jsonl (or --index) exists, else the MP4's own.`,
  diff: `Usage: serve-sim record diff <mp4> --from <seconds> --to <seconds> [-o out.png|-]
                            [--index <sidecar>] [--threshold <0-255>]

Diff the samples nearest --from and --to. Writes the --to frame dimmed, with
changed pixels in magenta and their bounding box outlined (default
<mp4-stem>-diff-<from>-<to>.png). Prints {"from","to","changedPixels","bbox","path",…}.
A pixel counts as changed when a channel differs by more than --threshold
(default ${DEFAULT_DIFF_THRESHOLD}, above H.264 noise; lower it for subtle changes).`,
  changes: `Usage: serve-sim record changes <mp4> [--from <seconds>] [--to <seconds>]
                               [--near <seconds>] [--index <sidecar>]

List frames whose pixels changed in the window and the HID events within --near
(default 0.5) seconds of them, from the sidecar only (no decoding). Prints JSON
with the header's fps, clock and duration.`,
};

class UsageError extends Error {}

/**
 * Seconds: `1.5`, `2s`, or `250ms`. Null when not a non-negative time.
 * @lintignore Exported for tests.
 */
export function parseInspectTime(raw: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(ms|s)?\s*$/.exec(raw);
  if (!m) return null;
  const value = Number(m[1]);
  const seconds = m[2] === "ms" ? value / 1000 : value;
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * The arguments after `record <verb>` in the raw argv. Commander's root parse
 * hands options it doesn't know (`-o`, `-t`, …) to `record` before it
 * dispatches to the subcommand, and `record` has its own `-o`/`-t`, so the
 * subcommand re-reads its arguments from argv.
 */
export function recordInspectArgv(argv: string[], verb: RecordInspectVerb): string[] {
  const record = argv.indexOf("record");
  const at = argv.indexOf(verb, record + 1);
  return at < 0 ? [] : argv.slice(at + 1);
}

type FlagSpec = { key: string; kind: "time" | "path" | "byte"; flags: string[] };

const FLAGS: Record<RecordInspectVerb, FlagSpec[]> = {
  frame: [
    { key: "t", kind: "time", flags: ["-t", "--time"] },
    { key: "output", kind: "path", flags: ["-o", "--output"] },
    { key: "index", kind: "path", flags: ["--index"] },
  ],
  diff: [
    { key: "from", kind: "time", flags: ["--from"] },
    { key: "to", kind: "time", flags: ["--to"] },
    { key: "output", kind: "path", flags: ["-o", "--output"] },
    { key: "index", kind: "path", flags: ["--index"] },
    { key: "threshold", kind: "byte", flags: ["--threshold"] },
  ],
  changes: [
    { key: "from", kind: "time", flags: ["--from"] },
    { key: "to", kind: "time", flags: ["--to"] },
    { key: "near", kind: "time", flags: ["--near"] },
    { key: "index", kind: "path", flags: ["--index"] },
  ],
};

/** @lintignore Exported for tests. */
export function parseRecordInspectArgs(verb: RecordInspectVerb, args: string[]): RecordInspectArgs {
  if (args.includes("-h") || args.includes("--help")) return { verb, help: true };
  const values: Record<string, string | number> = {};
  const positionals: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]!;
    if (arg === "-" || !arg.startsWith("-") || /^-\d/.test(arg)) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const spec = FLAGS[verb].find((s) => s.flags.includes(flag));
    if (!spec) throw new UsageError(`record ${verb}: unknown option ${flag}`);
    const raw = eq > 0 ? arg.slice(eq + 1) : args[++k];
    if (raw === undefined) throw new UsageError(`record ${verb}: ${flag} needs a value`);
    if (spec.kind === "path") {
      values[spec.key] = raw;
    } else if (spec.kind === "time") {
      const seconds = parseInspectTime(raw);
      if (seconds == null) throw new UsageError(`record ${verb}: ${flag}: expected seconds (e.g. 1.5, 2s, 250ms), got ${JSON.stringify(raw)}`);
      values[spec.key] = seconds;
    } else {
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n > 255) throw new UsageError(`record ${verb}: ${flag}: expected an integer 0-255, got ${JSON.stringify(raw)}`);
      values[spec.key] = n;
    }
  }
  const [mp4, extra] = positionals;
  if (extra !== undefined) throw new UsageError(`record ${verb}: unexpected argument ${extra}`);
  if (mp4 === undefined) throw new UsageError(`record ${verb}: <mp4> is required`);
  const require = (key: string, flag: string) => {
    if (values[key] === undefined) throw new UsageError(`record ${verb}: ${flag} <seconds> is required`);
  };
  if (verb === "frame") require("t", "-t");
  if (verb === "diff") {
    require("from", "--from");
    require("to", "--to");
  }
  return { verb, mp4, ...values } as RecordInspectArgs;
}

const STEM_EXT = /\.(mp4|mov|m4v)$/i;
function stemPath(mp4: string): string {
  const name = basename(mp4);
  return join(dirname(mp4), STEM_EXT.test(name) ? name.slice(0, -extname(name).length) : name);
}

/** Seconds for a file name: up to millisecond precision, no trailing zeros. */
const timeLabel = (seconds: number) => String(Math.round(seconds * 1000) / 1000);

/**
 * `<dir>/<stem>-t<seconds>.png`, next to the MP4.
 * @lintignore Exported for tests.
 */
export function defaultFrameOutput(mp4: string, t: number): string {
  return `${stemPath(mp4)}-t${timeLabel(t)}.png`;
}

/**
 * `<dir>/<stem>-diff-<from>-<to>.png`, next to the MP4.
 * @lintignore Exported for tests.
 */
export function defaultDiffOutput(mp4: string, from: number, to: number): string {
  return `${stemPath(mp4)}-diff-${timeLabel(from)}-${timeLabel(to)}.png`;
}

export type RecordInspectDeps = {
  videoInfo(path: string): Promise<VideoInfo>;
  videoFrame(path: string, seconds: number): Promise<VideoFrame>;
  log(line: string): void;
  error(line: string): void;
  writeStdout(bytes: Uint8Array): void;
  stdoutIsTTY: boolean;
};

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** Where frame times come from: the sidecar when there is one, else the MP4. */
type FrameSource = {
  duration: number;
  times: number[];
  /** Sample number (`i`) for position k in `times`. */
  sample(k: number): { i: number; changed?: boolean };
};

/** A located sample: what's reported, plus the half-duration used to decode it. */
type LocatedSample = { i: number; pts: number; changed?: boolean; k: number; half: number };

class InspectError extends Error {}

/**
 * The sidecar for `mp4`: `--index` must exist; the default path is optional
 * (null when absent) unless `required`. A malformed sidecar always throws.
 */
function loadIndex(mp4: string, explicit: string | undefined, required: boolean): ParsedRecordingIndex | null {
  const path = explicit ?? recordingIndexPath(mp4);
  try {
    return readRecordingIndex(path);
  } catch (error) {
    if (error instanceof RecordingIndexError && error.missing && !explicit && !required) return null;
    throw error;
  }
}

async function frameSource(mp4: string, index: ParsedRecordingIndex | null, deps: RecordInspectDeps): Promise<FrameSource> {
  // A truncated sidecar stops listing frames at its cap; the MP4 has them all.
  if (index && !index.footer?.truncated) {
    return {
      duration: recordingDuration(index),
      times: index.frames.map((f) => f.pts),
      sample: (k) => ({ i: index.frames[k]!.i, changed: index.frames[k]!.changed }),
    };
  }
  const info = await deps.videoInfo(mp4);
  const times = info.sampleTimes.map(round6);
  // `i` numbers the MP4's samples in order, so sample k is sidecar frame i=k.
  const changed = new Map(index?.frames.map((f) => [f.i, f.changed]));
  return {
    duration: round6(info.duration),
    times,
    sample: (k) => (changed.has(k) ? { i: k, changed: changed.get(k)! } : { i: k }),
  };
}

/**
 * How long sample k is shown: up to the next sample, else to the end of the
 * recording, else the previous gap.
 */
function sampleDuration(source: FrameSource, k: number): number {
  const { times } = source;
  if (k + 1 < times.length) return times[k + 1]! - times[k]!;
  const toEnd = source.duration - times[k]!;
  if (toEnd > 1e-6) return toEnd;
  return k > 0 ? times[k]! - times[k - 1]! : 1 / 60;
}

function locate(source: FrameSource, t: number, flag: string): LocatedSample {
  if (t < 0 || t > source.duration + 1e-6) {
    throw new InspectError(`${flag} ${t} is outside the recording (0–${source.duration} s)`);
  }
  const k = nearestIndex(source.times, t);
  if (k < 0) throw new InspectError("the recording has no video frames");
  return { pts: source.times[k]!, ...source.sample(k), k, half: sampleDuration(source, k) / 2 };
}

/**
 * Decode the located sample. The reported pts is rounded (and a sidecar's
 * slot/fps can differ from the MP4's 600-timescale time), so asking for it
 * exactly can land a hair before the sample starts and decode the previous
 * one. Ask for the middle of the sample instead, then check the decoder
 * returned a sample within half a frame of the expected pts.
 */
async function decodeSample(mp4: string, at: LocatedSample, deps: RecordInspectDeps): Promise<VideoFrame> {
  const frame = await deps.videoFrame(mp4, at.pts + at.half);
  if (!(Math.abs(frame.time - at.pts) < at.half)) {
    throw new InspectError(
      `asked for sample i=${at.i} at ${at.pts} s but decoded the one at ${round6(frame.time)} s; ` +
        "the sidecar may not match this MP4 (pass --index, or move the stale <name>.index.jsonl aside)",
    );
  }
  return frame;
}

/** Write a PNG to `output` (or stdout for `-`); returns the path to report. */
function emitPng(png: Uint8Array, output: string, deps: RecordInspectDeps): string {
  if (output === "-") {
    deps.writeStdout(png);
    return "-";
  }
  writeFileSync(output, png);
  return output;
}

function checkOutput(output: string | undefined, deps: RecordInspectDeps): void {
  if (output === "-" && deps.stdoutIsTTY) {
    throw new InspectError("-o -: refusing to write a PNG to a terminal; redirect stdout or pass -o <file>");
  }
  if (output && output !== "-" && !existsSync(dirname(output))) {
    throw new InspectError(`-o: directory ${dirname(output)} does not exist`);
  }
}

async function runFrame(args: FrameArgs, deps: RecordInspectDeps): Promise<void> {
  checkOutput(args.output, deps);
  const source = await frameSource(args.mp4, loadIndex(args.mp4, args.index, false), deps);
  const at = locate(source, args.t, "-t");
  const frame = await decodeSample(args.mp4, at, deps);
  const output = args.output ?? defaultFrameOutput(args.mp4, args.t);
  const path = emitPng(encodePng(frame), output, deps);
  const line = JSON.stringify({
    i: at.i,
    pts: at.pts,
    decodedPts: round6(frame.time),
    ...(at.changed !== undefined ? { changed: at.changed } : {}),
    path,
    width: frame.width,
    height: frame.height,
  });
  (output === "-" ? deps.error : deps.log)(line);
}

async function runDiff(args: DiffArgs, deps: RecordInspectDeps): Promise<void> {
  checkOutput(args.output, deps);
  const source = await frameSource(args.mp4, loadIndex(args.mp4, args.index, false), deps);
  const from = locate(source, args.from, "--from");
  const to = locate(source, args.to, "--to");
  const before = await decodeSample(args.mp4, from, deps);
  const after = to.k === from.k ? before : await decodeSample(args.mp4, to, deps);
  const diff = diffFrames(before, after, args.threshold !== undefined ? { threshold: args.threshold } : {});
  const output = args.output ?? defaultDiffOutput(args.mp4, args.from, args.to);
  const path = emitPng(encodePng(renderDiffImage(after, diff)), output, deps);
  const line = JSON.stringify({
    from: { i: from.i, pts: from.pts, decodedPts: round6(before.time) },
    to: { i: to.i, pts: to.pts, decodedPts: round6(after.time) },
    changedPixels: diff.changedPixels,
    bbox: diff.bbox,
    path,
    width: diff.width,
    height: diff.height,
  });
  (output === "-" ? deps.error : deps.log)(line);
}

function runChanges(args: ChangesArgs, deps: RecordInspectDeps): void {
  let index: ParsedRecordingIndex;
  try {
    index = loadIndex(args.mp4, args.index, true)!;
  } catch (error) {
    if (error instanceof RecordingIndexError && error.missing) {
      throw new InspectError(
        `${error.message}. \`record changes\` reads the sidecar only (it never decodes the video): ` +
          "re-record without --no-index so `serve-sim record` writes <name>.index.jsonl next to the MP4, or pass --index <path>.",
      );
    }
    throw error;
  }
  deps.log(JSON.stringify(recordingChanges(index, { from: args.from, to: args.to, near: args.near })));
}

/**
 * Run a parsed `record frame|diff|changes`; resolves with the exit code.
 * @lintignore Exported for tests.
 */
export async function runRecordInspect(args: RecordInspectArgs, deps: RecordInspectDeps): Promise<number> {
  if ("help" in args) {
    deps.log(RECORD_INSPECT_USAGE[args.verb]);
    return 0;
  }
  try {
    if (!existsSync(args.mp4)) throw new InspectError(`No such recording: ${args.mp4}`);
    if (args.verb === "frame") await runFrame(args, deps);
    else if (args.verb === "diff") await runDiff(args, deps);
    else runChanges(args, deps);
    return 0;
  } catch (error) {
    deps.error(`record ${args.verb}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Parse then run; usage errors print the verb's usage and exit 1. */
export async function recordInspect(verb: RecordInspectVerb, argv: string[], deps: RecordInspectDeps): Promise<number> {
  let args: RecordInspectArgs;
  try {
    args = parseRecordInspectArgs(verb, argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    deps.error(`serve-sim ${error.message}\n\n${RECORD_INSPECT_USAGE[verb]}`);
    return 1;
  }
  return runRecordInspect(args, deps);
}
