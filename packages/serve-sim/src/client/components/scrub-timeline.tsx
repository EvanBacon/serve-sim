import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, History, Pause, Play, X } from "lucide-react";
import { SimulatorToolbar } from "../simulator";
import { inkFill } from "../utils/theme";
import {
  activeMarker,
  adjacentMarker,
  describeMarker,
  formatTimelineTime,
  frameIndexAt,
  recordingSeekTime,
  stepFrame,
  type TimelineMarker,
  type TimelineSource,
} from "../utils/scrub-timeline";
import type { SavedRecording } from "../hooks/use-screen-recording";
import {
  useBufferFrameUrl,
  useScrubTimeline,
  type BufferStatus,
  type TimelineSourceKind,
} from "../hooks/use-scrub-timeline";

/** Vertical space the open timeline takes under the device (bar + gap). */
export const SCRUB_TIMELINE_RESERVED_HEIGHT = 104;
/**
 * Narrowest bar: fits the fullest header row (play, time, Buffer/Recording,
 * close, open, Live). Below it (a narrow window) the time drops its
 * duration and then truncates instead of pushing Live off the bar.
 */
export const SCRUB_TIMELINE_MIN_WIDTH = 420;

const TAP_COLOR = "var(--serve-sim-accent)";
const DRAG_COLOR = "var(--serve-sim-warning)";
const OTHER_COLOR = "var(--serve-sim-icon)";
const PLAYHEAD_COLOR = "var(--serve-sim-tint)";

const markerColor = (marker: TimelineMarker) =>
  marker.kind === "tap" ? TAP_COLOR : marker.kind === "drag" ? DRAG_COLOR : OTHER_COLOR;

/** Toolbar toggle that shows/hides the timeline under the device. */
export function ScrubTimelineToolbarButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <SimulatorToolbar.Button
      aria-label="Timeline"
      aria-pressed={open}
      title="Timeline"
      onClick={(e) => { e.preventDefault(); onToggle(); }}
      style={open ? { color: "var(--serve-sim-tint)" } : undefined}
    >
      <History size={18} strokeWidth={2} />
    </SimulatorToolbar.Button>
  );
}

const pctOf = (t: number, duration: number) => `${duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0}%`;

const smallButtonClass =
  "shrink-0 h-[26px] min-w-[26px] px-1.5 inline-flex items-center justify-center gap-1 bg-transparent border-none rounded-md text-icon text-[12px] font-medium cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] hover:bg-ink/8 hover:text-ink disabled:cursor-default disabled:hover:bg-transparent";

/** @lintignore Exported for tests. */
export type ScrubTimelineBarProps = {
  source: TimelineSource | null;
  sourceKind: TimelineSourceKind;
  position: number | null;
  playing: boolean;
  bufferStatus: BufferStatus;
  hasBuffer: boolean;
  recordingName?: string | null;
  onSeek: (t: number | null) => void;
  onTogglePlay: () => void;
  onPause: () => void;
  onSelectSource: (kind: TimelineSourceKind) => void;
  onStartBuffer: () => void;
  onOpenFiles: (files: File[]) => void;
  onCloseRecording: () => void;
  /** Marker whose details are showing (hover, click, or keyboard). */
  focusedMarkerId?: number | null;
  onFocusMarker?: (id: number | null) => void;
  style?: CSSProperties;
};

function emptyMessage(kind: TimelineSourceKind, status: BufferStatus): string {
  if (kind === "recording") return "No recording loaded.";
  if (status === "off") return "Buffer is off.";
  if (status === "unavailable") return "No rolling buffer on this server.";
  if (status === "on") return "The buffer is filling…";
  return "Loading…";
}

/**
 * The seekable bar: controls row + a track with frame ticks, HID markers,
 * and the playhead. Presentational; all state comes from props.
 *
 * Keys (only while the track has focus): ←/→ one frame, ⇧←/⇧→ previous/next
 * marker, Home/End, Space play/pause, Esc back to live.
 * @lintignore Exported for tests.
 */
export function ScrubTimelineBar(props: ScrubTimelineBarProps) {
  const {
    source, sourceKind, position, playing, bufferStatus, hasBuffer, recordingName,
    onSeek, onTogglePlay, onPause, onSelectSource, onStartBuffer, onOpenFiles, onCloseRecording,
    focusedMarkerId = null, onFocusMarker,
  } = props;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const draggingRef = useRef(false);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const duration = source?.duration ?? 0;
  const live = position === null;
  const shownT = position ?? duration;

  const timeAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration;
  };

  const onTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!source || e.button !== 0) return;
    e.preventDefault();
    trackRef.current?.focus();
    trackRef.current?.setPointerCapture?.(e.pointerId);
    draggingRef.current = true;
    onPause();
    onSeek(timeAt(e.clientX));
  };
  const onTrackPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!source) return;
    const t = timeAt(e.clientX);
    setHoverT(t);
    if (draggingRef.current) onSeek(t);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    trackRef.current?.releasePointerCapture?.(e.pointerId);
  };

  const onTrackKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!source || e.metaKey || e.ctrlKey || e.altKey) return;
    let handled = true;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        onPause();
        if (e.shiftKey) {
          const marker = adjacentMarker(source, shownT, dir);
          if (marker) {
            onSeek(marker.t);
            onFocusMarker?.(marker.id);
          }
        } else {
          onSeek(stepFrame(source, shownT, dir));
          onFocusMarker?.(null);
        }
        break;
      }
      case "Home":
        onPause();
        onSeek(0);
        break;
      case "End":
        onPause();
        onSeek(source.frames.at(-1)?.t ?? duration);
        break;
      case " ":
        onTogglePlay();
        break;
      case "Escape":
        if (live) handled = false;
        else onSeek(null);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      // The page-level handler forwards keys to the simulator; these are ours.
      e.stopPropagation();
    }
  };

  const focused = source?.markers.find((m) => m.id === focusedMarkerId) ?? null;
  const changedTicks = source && source.frames.length <= 4000 ? source.frames.filter((f) => f.changed) : [];
  const valueText = source
    ? `${live ? "Live" : formatTimelineTime(shownT)} of ${formatTimelineTime(duration)}`
    : emptyMessage(sourceKind, bufferStatus);

  return (
    <div
      data-scrub-timeline
      className="@container flex flex-col gap-1.5 font-system select-none"
      style={{
        padding: "6px 10px 8px",
        borderRadius: 16,
        background: "var(--serve-sim-panel-bg, #181818)",
        border: `1px solid ${inkFill(0.1)}`,
        boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
        boxSizing: "border-box",
        ...props.style,
      }}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <button
          type="button"
          className={smallButtonClass}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          disabled={!source}
          onClick={onTogglePlay}
        >
          {playing ? <Pause size={15} strokeWidth={2} /> : <Play size={15} strokeWidth={2} />}
        </button>
        <span
          data-testid="scrub-time"
          className="min-w-0 shrink text-[12px] font-mono text-ink-70 whitespace-nowrap overflow-hidden text-ellipsis"
          style={{ fontVariantNumeric: "tabular-nums" }}
          title={source ? `${live ? "live" : formatTimelineTime(shownT)} / ${formatTimelineTime(duration)}` : undefined}
        >
          {source ? (
            <>
              {live ? "live" : formatTimelineTime(shownT)}
              <span data-testid="scrub-duration" className="@max-[400px]:hidden"> / {formatTimelineTime(duration)}</span>
            </>
          ) : "—"}
        </span>
        <span className="flex-1 min-w-0" />
        {(recordingName || hasBuffer || bufferStatus === "on") && (
          <div role="radiogroup" aria-label="Timeline source" className="shrink-0 inline-flex items-center rounded-md bg-ink/6 p-0.5">
            {(["buffer", "recording"] as const).map((kind) => {
              const available = kind === "buffer" ? true : !!recordingName;
              const selected = sourceKind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!available}
                  title={kind === "recording" ? recordingName ?? "No recording loaded" : "Rolling buffer"}
                  onClick={() => onSelectSource(kind)}
                  className={`h-[22px] px-2 border-none rounded-[5px] text-[11px] font-medium cursor-pointer disabled:cursor-default ${selected ? "bg-control-selected text-ink" : "bg-transparent text-icon hover:text-ink"}`}
                >
                  {kind === "buffer" ? "Buffer" : "Recording"}
                </button>
              );
            })}
          </div>
        )}
        {sourceKind === "recording" && recordingName && (
          <button type="button" className={smallButtonClass} aria-label="Close recording" title={`Close ${recordingName}`} onClick={onCloseRecording}>
            <X size={14} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          className={smallButtonClass}
          aria-label="Open recording"
          title="Open a recording (.mp4 + .index.jsonl)"
          onClick={() => fileRef.current?.click()}
        >
          <FolderOpen size={15} strokeWidth={2} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".mp4,.mov,.m4v,.jsonl,video/*"
          hidden
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = "";
            if (files.length > 0) onOpenFiles(files);
          }}
        />
        <button
          type="button"
          className={smallButtonClass}
          aria-label="Back to live"
          title="Back to live (Esc)"
          disabled={live}
          onClick={() => onSeek(null)}
          style={{ color: live ? "var(--serve-sim-success)" : undefined }}
        >
          <span aria-hidden className="size-1.5 rounded-full" style={{ background: live ? "var(--serve-sim-success)" : "currentColor" }} />
          Live
        </button>
      </div>

      {source ? (
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Timeline"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration * 1000) / 1000}
          aria-valuenow={Math.round(shownT * 1000) / 1000}
          aria-valuetext={valueText}
          data-testid="scrub-track"
          className="relative h-[30px] rounded-md bg-ink/6 cursor-pointer outline-none focus-visible:[box-shadow:0_0_0_2px_var(--serve-sim-tint)] touch-none"
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => setHoverT(null)}
          onKeyDown={onTrackKeyDown}
          onKeyUp={(e) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End", " ", "Escape"].includes(e.key)) e.stopPropagation();
          }}
        >
          {changedTicks.map((f) => (
            <span
              key={`f${f.frame}:${f.t}`}
              aria-hidden
              className="absolute bottom-0 w-px h-[6px] bg-ink/45 pointer-events-none"
              style={{ left: pctOf(f.t, duration) }}
            />
          ))}
          {source.markers.map((marker) => (
            <TimelineMarkerButton
              key={marker.id}
              marker={marker}
              duration={duration}
              focused={marker.id === focusedMarkerId}
              onFocusMarker={onFocusMarker}
              onSeek={(t) => { onPause(); onSeek(t); }}
            />
          ))}
          {hoverT !== null && !draggingRef.current && (
            <span
              aria-hidden
              className="absolute top-0 bottom-0 w-px bg-ink/55 pointer-events-none"
              style={{ left: pctOf(hoverT, duration) }}
            />
          )}
          {!live && (
            <span
              data-testid="scrub-playhead"
              aria-hidden
              className="absolute -top-[3px] -bottom-[3px] w-[2px] -ml-px rounded-full pointer-events-none"
              style={{ left: pctOf(shownT, duration), background: PLAYHEAD_COLOR }}
            />
          )}
          {focused && (
            <span
              role="status"
              data-testid="scrub-marker-detail"
              className="absolute bottom-[calc(100%+4px)] -translate-x-1/2 px-2 py-0.5 rounded-md bg-panel border border-ink/10 text-[11px] font-mono text-ink whitespace-nowrap pointer-events-none z-10"
              style={{
                left: `clamp(80px, ${pctOf(focused.t, duration)}, calc(100% - 80px))`,
                boxShadow: "var(--serve-sim-shadow-popover)",
              }}
            >
              {describeMarker(focused)}
            </span>
          )}
        </div>
      ) : (
        <div className="h-[30px] flex items-center gap-1.5 px-1 text-[12px] text-ink-70 whitespace-nowrap overflow-hidden">
          <span>{emptyMessage(sourceKind, bufferStatus)}</span>
          {sourceKind === "buffer" && bufferStatus === "off" && (
            <button type="button" className={`${smallButtonClass} text-tint`} onClick={onStartBuffer}>
              Start buffer
            </button>
          )}
          {sourceKind === "buffer" && bufferStatus !== "on" && (
            <span className="text-ink-55 overflow-hidden text-ellipsis">or record while this is open</span>
          )}
        </div>
      )}
    </div>
  );
}

function TimelineMarkerButton({
  marker, duration, focused, onFocusMarker, onSeek,
}: {
  marker: TimelineMarker;
  duration: number;
  focused: boolean;
  onFocusMarker?: (id: number | null) => void;
  onSeek: (t: number) => void;
}) {
  const color = markerColor(marker);
  const isSpan = marker.kind === "drag" && marker.tEnd != null;
  const label = describeMarker(marker);
  const left = pctOf(marker.t, duration);
  const ring = focused ? `0 0 0 2px ${color}` : undefined;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={`${label}\n${marker.summary}`}
      data-marker-kind={marker.kind}
      data-marker-id={marker.id}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onSeek(marker.t);
        onFocusMarker?.(marker.id);
      }}
      onMouseEnter={() => onFocusMarker?.(marker.id)}
      onMouseLeave={() => onFocusMarker?.(null)}
      className="absolute top-1/2 -translate-y-1/2 p-0 border-none cursor-pointer"
      style={isSpan
        ? {
          left,
          width: `max(6px, calc(${pctOf(marker.tEnd! - marker.t, duration)}))`,
          height: 6,
          borderRadius: 3,
          background: color,
          boxShadow: ring,
          zIndex: focused ? 3 : 1,
        }
        : {
          left,
          width: marker.kind === "tap" ? 10 : 8,
          height: marker.kind === "tap" ? 10 : 8,
          marginLeft: marker.kind === "tap" ? -5 : -4,
          borderRadius: marker.kind === "tap" ? "50%" : 2,
          background: color,
          outline: "2px solid var(--serve-sim-panel-bg, #181818)",
          boxShadow: ring,
          zIndex: focused ? 3 : 2,
        }}
    />
  );
}

/** Where an input landed on the shown frame: a ring for taps, a path for drags. */
function MarkerOnFrame({ marker }: { marker: TimelineMarker }) {
  if (marker.x == null || marker.y == null) return null;
  const color = markerColor(marker);
  return (
    <>
      {marker.start && (
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden>
          <line
            x1={marker.start.x} y1={marker.start.y} x2={marker.x} y2={marker.y}
            stroke={color} strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <span
        data-testid="scrub-frame-marker"
        aria-hidden
        className="absolute size-7 -ml-3.5 -mt-3.5 rounded-full pointer-events-none"
        style={{
          left: `${marker.x * 100}%`,
          top: `${marker.y * 100}%`,
          border: `3px solid ${color}`,
          boxShadow: "0 0 0 1px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(0,0,0,0.45)",
        }}
      />
    </>
  );
}

/** Raw framebuffer size + the clockwise CSS rotation that shows it upright. */
export type RawFrameGeometry = { width: number; height: number; rotationDegrees: number };

/**
 * Box for a raw-orientation frame inside the overlay (a `container-type:
 * size` element): fitted like `object-contain` to the overlay, then rotated
 * the way `SimulatorView` rotates the live stream. Raw-normalized points
 * placed as % of this box land where they were on the rotated screen.
 * @lintignore Exported for tests.
 */
export function rawFrameBoxStyle(geometry: RawFrameGeometry | null | undefined): CSSProperties {
  if (!geometry || !(geometry.width > 0) || !(geometry.height > 0)) {
    return { position: "absolute", inset: 0 };
  }
  const rotation = ((Math.round(geometry.rotationDegrees) % 360) + 540) % 360 - 180;
  const sideways = Math.abs(rotation) === 90;
  // Aspect (w/h) as shown on screen.
  const shown = sideways ? geometry.height / geometry.width : geometry.width / geometry.height;
  const shownWidth = `min(100cqw, ${(100 * shown).toFixed(4)}cqh)`;
  const shownHeight = `min(100cqh, ${(100 / shown).toFixed(4)}cqw)`;
  return {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: sideways ? shownHeight : shownWidth,
    height: sideways ? shownWidth : shownHeight,
    transform: `translate(-50%, -50%)${rotation === 0 ? "" : ` rotate(${rotation}deg)`}`,
    transformOrigin: "center center",
  };
}

type ScrubFrameOverlayProps = {
  kind: TimelineSourceKind;
  /**
   * Raw geometry of the frame: buffer JPEGs and event points are raw
   * framebuffer orientation. Buffer: the live stream's; recording: the
   * sidecar header's (the MP4 itself plays upright).
   */
  geometry?: RawFrameGeometry | null;
  /** Buffer: JPEG URL of the frame at `position`. */
  imageUrl?: string | null;
  /** Recording: MP4 URL. */
  videoUrl?: string | null;
  /** Recording: video time to show while paused (mid-sample). */
  seekTime?: number;
  playing?: boolean;
  onVideoTime?: (t: number) => void;
  onVideoEnded?: () => void;
  marker?: TimelineMarker | null;
  label: string;
  missing?: boolean;
  borderRadius?: CSSProperties["borderRadius"];
};

/**
 * Covers the live screen with the scrubbed frame. Takes pointer input so a
 * click on a past frame can't tap the live app underneath.
 * @lintignore Exported for tests.
 */
export function ScrubFrameOverlay({
  kind, geometry, imageUrl, videoUrl, seekTime = 0, playing = false, onVideoTime, onVideoEnded, marker, label, missing, borderRadius,
}: ScrubFrameOverlayProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onTimeRef = useRef(onVideoTime);
  onTimeRef.current = onVideoTime;
  const onEndedRef = useRef(onVideoEnded);
  onEndedRef.current = onVideoEnded;
  // Where playback starts; while playing the <video> drives the time.
  const seekTimeRef = useRef(seekTime);
  seekTimeRef.current = seekTime;

  // Paused: show exactly the sample under the playhead.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || playing) return;
    video.pause();
    if (Math.abs(video.currentTime - seekTime) > 1e-4) video.currentTime = seekTime;
  }, [seekTime, playing, videoUrl]);

  // Playing: let the <video> run and report its clock back.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing) return;
    video.currentTime = seekTimeRef.current;
    void video.play().catch(() => onEndedRef.current?.());
    let raf = 0;
    const tick = () => {
      onTimeRef.current?.(video.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      video.pause();
    };
  }, [playing, videoUrl]);

  return (
    <div
      data-testid="scrub-frame-overlay"
      className="absolute inset-0 z-[15] overflow-hidden bg-black pointer-events-auto cursor-default"
      style={{ borderRadius, containerType: "size" }}
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => e.stopPropagation()}
    >
      {kind === "recording" && videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          muted
          playsInline
          preload="auto"
          className="absolute inset-0 w-full h-full object-contain"
          onEnded={onVideoEnded}
        />
      ) : null}
      {/* Raw-orientation frame: the buffer JPEG and the input markers rotate together. */}
      <div data-testid="scrub-frame-box" className="pointer-events-none" style={rawFrameBoxStyle(geometry)}>
        {kind === "buffer" && imageUrl && (
          <img src={imageUrl} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill" />
        )}
        {marker && <MarkerOnFrame marker={marker} />}
      </div>
      <span
        className="absolute bottom-6 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-ink/75 text-ink-inverse text-[11px] font-mono whitespace-nowrap pointer-events-none"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {label}{missing ? " · frame evicted" : ""}
      </span>
    </div>
  );
}

/** Wall-clock time of a buffer position (`12:03:04.5`); stays right while the view is frozen. */
function bufferWallTime(source: TimelineSource, t: number): string {
  const origin = source.origin ? Date.parse(source.origin) : Number.NaN;
  if (!Number.isFinite(origin)) return formatTimelineTime(t);
  const at = new Date(origin + t * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${Math.floor(at.getMilliseconds() / 100)}`;
}

/**
 * The timeline under the device plus, while scrubbing, the past frame over
 * the screen (portaled into `overlayTarget`, the screen slot). Stays mounted
 * while closed so a loaded recording survives hide/show; closed, it renders
 * nothing and fetches nothing.
 */
export function ScrubTimeline({
  device,
  open,
  saved,
  onSavedConsumed,
  streamGeometry,
  overlayTarget,
  overlayBorderRadius,
  style,
}: {
  device: string;
  open: boolean;
  saved?: SavedRecording | null;
  onSavedConsumed?: () => void;
  /** The live stream's raw size and CSS rotation (buffer frames match it). */
  streamGeometry?: RawFrameGeometry | null;
  overlayTarget: HTMLElement | null;
  overlayBorderRadius?: CSSProperties["borderRadius"];
  style?: CSSProperties;
}) {
  const timeline = useScrubTimeline({ device, open, saved, onSavedConsumed });
  const { source, sourceKind, position, playing } = timeline;
  const [focusedMarkerId, setFocusedMarkerId] = useState<number | null>(null);
  useEffect(() => setFocusedMarkerId(null), [source?.kind, timeline.recording?.videoUrl]);

  const frameIndex = source && position !== null ? frameIndexAt(source.frames, position) : -1;
  const bufferFrameId = sourceKind === "buffer" && frameIndex >= 0 ? source!.frames[frameIndex]!.frame : null;
  const bufferFrame = useBufferFrameUrl(device, bufferFrameId);

  const focusedMarker = source?.markers.find((m) => m.id === focusedMarkerId) ?? null;
  const frameMarker = source && position !== null
    ? (focusedMarker && Math.abs(focusedMarker.t - position) < 1 ? focusedMarker : activeMarker(source, position))
    : null;

  const recordingFrame = source?.kind === "recording" ? source.frame : undefined;
  const frameGeometry: RawFrameGeometry | null = sourceKind === "buffer"
    ? streamGeometry ?? null
    : recordingFrame?.width && recordingFrame.height
      ? { width: recordingFrame.width, height: recordingFrame.height, rotationDegrees: recordingFrame.rotation }
      : null;
  // A rotated recording without its size can't place points; skip the ring.
  const markerPlaceable = sourceKind === "buffer" || frameGeometry !== null || !recordingFrame?.rotation;

  if (!open) return null;
  const overlay = source && position !== null && overlayTarget
    ? createPortal(
      <ScrubFrameOverlay
        kind={sourceKind}
        geometry={frameGeometry}
        imageUrl={bufferFrame.url}
        missing={bufferFrame.missing}
        videoUrl={timeline.recording?.videoUrl}
        seekTime={sourceKind === "recording" ? recordingSeekTime(source, position) : 0}
        playing={playing}
        onVideoTime={(t) => timeline.seek(t)}
        onVideoEnded={() => timeline.setPlaying(false)}
        marker={markerPlaceable ? frameMarker : null}
        label={sourceKind === "buffer"
          ? `buffer · ${bufferWallTime(source, position)}`
          : `recording · ${formatTimelineTime(position)}`}
        borderRadius={overlayBorderRadius}
      />,
      overlayTarget,
    )
    : null;

  return (
    <>
      <ScrubTimelineBar
        source={source}
        sourceKind={sourceKind}
        position={position}
        playing={playing}
        bufferStatus={timeline.bufferStatus}
        hasBuffer={timeline.hasBuffer}
        recordingName={timeline.recording?.fileName ?? null}
        onSeek={timeline.seek}
        onTogglePlay={timeline.togglePlaying}
        onPause={() => timeline.setPlaying(false)}
        onSelectSource={timeline.selectSource}
        onStartBuffer={() => void timeline.startBuffer()}
        onOpenFiles={(files) => void timeline.openFiles(files)}
        onCloseRecording={timeline.closeRecording}
        focusedMarkerId={focusedMarkerId}
        onFocusMarker={setFocusedMarkerId}
        style={style}
      />
      {overlay}
    </>
  );
}
