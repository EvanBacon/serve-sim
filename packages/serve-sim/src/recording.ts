/**
 * Screen-recording helpers shared by the device session (HTTP endpoints), the
 * `serve-sim record` CLI, and the preview toolbar.
 *
 * Wire protocol (device-scoped helper routes, `…/helper/<udid>/recording`):
 *   GET  /recording        → { recording, startedAt? }
 *   POST /recording/start  → ?codec=h264|hevc&fps=1..120&bitrate=<bits/s>
 *   POST /recording/stop   → the finished MP4 (video/mp4, attachment), with the
 *                            native summary JSON in `X-Serve-Sim-Recording`.
 */
import type { RecordingCodec, RecordingStartOptions } from "./native";
import type { SimulatorOrientation } from "./client/types";
import { streamDisplayGeometry } from "./client/simulator/orientation";

export const RECORDING_SUMMARY_HEADER = "X-Serve-Sim-Recording";
export const DEFAULT_RECORDING_FPS = 60;

const CODECS = new Set<RecordingCodec>(["h264", "hevc"]);

/** Parse `/recording/start` query params, or return an error message. */
export function parseRecordingQuery(
  params: URLSearchParams,
): Omit<RecordingStartOptions, "rotation"> | { error: string } {
  const codec = (params.get("codec") ?? "h264").toLowerCase();
  if (!CODECS.has(codec as RecordingCodec)) return { error: `unsupported codec: ${codec} (h264|hevc)` };
  const fpsRaw = params.get("fps");
  const fps = fpsRaw == null ? DEFAULT_RECORDING_FPS : Number(fpsRaw);
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) return { error: `fps must be an integer 1..120` };
  const bitrateRaw = params.get("bitrate");
  let bitrate: number | undefined;
  if (bitrateRaw != null) {
    bitrate = Number(bitrateRaw);
    if (!Number.isInteger(bitrate) || bitrate < 100_000 || bitrate > 500_000_000) {
      return { error: "bitrate must be an integer in bits/s (100000..500000000)" };
    }
  }
  return { codec: codec as RecordingCodec, fps, ...(bitrate != null ? { bitrate } : {}) };
}

/**
 * Clockwise rotation for the MP4 track so the file plays upright, matching
 * the CSS rotation the viewer applies to the (always native-portrait) stream.
 */
export function recordingRotation(
  config: { width: number; height: number; orientation?: string | null },
): number {
  return streamDisplayGeometry({
    width: config.width,
    height: config.height,
    orientation: (config.orientation ?? "portrait") as SimulatorOrientation,
  }).rotationDegrees;
}

/** `serve-sim-recording-2026-10-22-23-45-12.mp4` (local time). */
export function recordingFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = [
    date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()),
    pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds()),
  ].join("-");
  return `serve-sim-recording-${stamp}.mp4`;
}

/**
 * `…/recording[/action]` for an input target, derived from its HID socket URL
 * (`…/helper/<udid>/ws`). Works for local state files and `--url` remotes.
 */
export function recordingUrlForWsUrl(wsUrl: string, action?: "start" | "stop"): string | null {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return null;
  }
  if (!url.pathname.endsWith("/ws")) return null;
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.slice(0, -"ws".length) + (action ? `recording/${action}` : "recording");
  url.search = "";
  return url.toString();
}

/** Parse a CLI duration like `10`, `10s`, `1.5m`, or `500ms` to milliseconds. */
export function parseRecordingDuration(raw: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/.exec(raw);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2] ?? "s";
  const ms = unit === "ms" ? value : unit === "m" ? value * 60_000 : value * 1000;
  return ms > 0 && Number.isFinite(ms) ? Math.round(ms) : null;
}
