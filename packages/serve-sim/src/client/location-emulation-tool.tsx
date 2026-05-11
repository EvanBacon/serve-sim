// Location emulation panel + lightweight 3D trail viz.
//
// Drives `xcrun simctl location <udid> set <lat>,<lng>` on a fixed cadence
// while a requestAnimationFrame loop advances the player position along a
// pre-densified route. The route is rendered to a 2D canvas with a manual
// orbiting orthographic camera — same family as Any Distance's RouteScene
// (extruded ribbon + ground plane shadow) but flat-shaded so we don't pull
// in WebGL or a 3D library.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_TRAILS,
  defaultSpeed,
  pointAtDistance,
  prepareTrail,
  type PreparedTrail,
  type RoutePoint,
  type Trail,
  type TrailMode,
} from "./trails";
import {
  ArrowGlyph,
  Chevron,
  CycleGlyph,
  DriveGlyph,
  FastForwardGlyph,
  PauseGlyph,
  PlayGlyph,
  RunGlyph,
  StopGlyph,
  WalkGlyph,
} from "./icons";

const TRAIL_MORPH_MS = 650;

// Inline hover styles — inline `style` objects can't express :hover, so we
// emit a small style sheet keyed off classnames the components apply.
// TODO: Convert to Tailwind
const HOVER_CSS = `
.lem-toggle:hover { color: #fff; }
.lem-toggle:hover .lem-chevron { color: rgba(255,255,255,0.85) !important; }
.lem-select:hover { background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.16); }
.lem-select:focus { outline: none; border-color: rgba(255,255,255,0.24); background: rgba(255,255,255,0.08); }
.lem-primary:hover:not(:disabled) { filter: brightness(1.08); }
.lem-primary-on:hover:not(:disabled) { background: rgba(255,255,255,0.22) !important; filter: none; }
.lem-ghost:hover:not(:disabled) { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.2); color: #fff; }
.lem-ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.lem-seg:hover:not([aria-pressed="true"]) { color: rgba(255,255,255,0.9); background: rgba(255,255,255,0.05) !important; }
.lem-speed:hover { background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.18); color: #fff; }
.lem-speed-on:hover { background: rgba(255,255,255,0.88) !important; border-color: rgba(255,255,255,0.88) !important; color: #0a0a0c !important; }
.lem-speed:active { transform: scale(0.97); }
`;

interface ExecResult { stdout: string; stderr: string; exitCode: number }
type ExecFn = (cmd: string) => Promise<ExecResult>;

const SPEED_MULTIPLIERS = [1, 2, 5, 20] as const;
type SpeedMultiplier = (typeof SPEED_MULTIPLIERS)[number];

/** simctl set cadence — match real CoreLocation's typical 1Hz update rate. */
const LOCATION_PUSH_INTERVAL_MS = 1000;

interface PlaybackState {
  status: "idle" | "playing" | "paused";
  /** Arc-length offset (meters) along the prepared trail. */
  arc: number;
  /** Wall-clock elapsed time while playing, milliseconds. */
  elapsedMs: number;
}

const INITIAL_PLAYBACK: PlaybackState = { status: "idle", arc: 0, elapsedMs: 0 };

// ─── Tool component ────────────────────────────────────────────────────────

export function LocationEmulationTool({
  udid,
  exec,
}: {
  udid: string;
  exec: ExecFn;
}) {
  const [open, setOpen] = useState(true);
  const [trailId, setTrailId] = useState<string>(DEFAULT_TRAILS[0]!.id);
  const [mode, setMode] = useState<TrailMode>(DEFAULT_TRAILS[0]!.mode);
  const [multiplier, setMultiplier] = useState<SpeedMultiplier>(1);
  const [playback, setPlayback] = useState<PlaybackState>(INITIAL_PLAYBACK);
  const [error, setError] = useState<string | null>(null);

  const trail = useMemo<Trail>(
    () => DEFAULT_TRAILS.find((t) => t.id === trailId) ?? DEFAULT_TRAILS[0]!,
    [trailId],
  );
  const prepared = useMemo(() => prepareTrail(trail), [trail]);

  // ── Animator ─────────────────────────────────────────────────────────────
  // Ref-mirrored state so the rAF callback (which captures across renders)
  // can read the latest values without re-subscribing.
  const arcRef = useRef(0);
  const statusRef = useRef<PlaybackState["status"]>("idle");
  const speedRef = useRef(defaultSpeed(mode) * multiplier);
  const elapsedRef = useRef(0);
  const trailRef = useRef(prepared);
  // Captured at the start of a session — the lat/lng the simulator was at
  // when the user first hit play. Restored on stop so the device returns to
  // where they were before the simulation started.
  const sessionOriginRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => { speedRef.current = defaultSpeed(mode) * multiplier; }, [mode, multiplier]);
  // Morph state — when the trail changes we keep the previous prepared trail
  // around briefly so the renderer can interpolate between the two shapes.
  // The state precomputes nearest-neighbour-aligned point samples so each
  // frame is just a cheap lerp.
  const morphRef = useRef<MorphState | null>(null);
  useEffect(() => {
    const previous = trailRef.current;
    const previousArc = arcRef.current;
    trailRef.current = prepared;
    if (previous && previous !== prepared) {
      morphRef.current = buildMorphState(previous, previousArc, prepared, performance.now());
    }
    // Reset progress when the route changes.
    arcRef.current = 0;
    elapsedRef.current = 0;
    statusRef.current = "idle";
    sessionOriginRef.current = null;
    setPlayback(INITIAL_PLAYBACK);
  }, [prepared]);

  // Visualisation tick — runs continuously even while paused/idle so the
  // camera keeps spinning lazily.
  const cameraAngleRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = (ts: number) => {
      const last = lastFrameRef.current;
      const dt = last == null ? 16 : Math.min(64, ts - last);
      lastFrameRef.current = ts;

      cameraAngleRef.current = (cameraAngleRef.current + dt * 0.00012) % (Math.PI * 2);

      if (statusRef.current === "playing") {
        const advance = (speedRef.current * dt) / 1000;
        arcRef.current += advance;
        elapsedRef.current += dt;
        const total = trailRef.current.totalDistance;
        if (!trailRef.current.trail.loop && arcRef.current >= total) {
          arcRef.current = total;
          statusRef.current = "paused";
          // Surface the stop to React state so the UI updates the toggle.
          setPlayback({ status: "paused", arc: total, elapsedMs: elapsedRef.current });
        }
      }

      const canvas = canvasRef.current;
      if (canvas) {
        let renderTrail = trailRef.current;
        let markerOverride: Vec3 | null = null;
        const morph = morphRef.current;
        if (morph) {
          const t = (ts - morph.startMs) / TRAIL_MORPH_MS;
          if (t >= 1) {
            morphRef.current = null;
          } else {
            const eased = easeInOut(t);
            renderTrail = morphFrame(morph, eased);
            // Slide the player marker from its previous trail position to
            // the new trail's start point alongside the shape morph.
            markerOverride = {
              x: morph.prevMarker.x + (morph.nextMarker.x - morph.prevMarker.x) * eased,
              y: morph.prevMarker.y + (morph.nextMarker.y - morph.prevMarker.y) * eased,
              z: morph.prevMarker.z + (morph.nextMarker.z - morph.prevMarker.z) * eased,
            };
          }
        }
        renderScene(
          canvas,
          renderTrail,
          arcRef.current,
          cameraAngleRef.current,
          ts,
          statusRef.current === "playing",
          markerOverride,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Periodically reflect arc/elapsed into React state for the stats row,
  // throttled to keep re-renders cheap (the 60fps animation lives in refs).
  useEffect(() => {
    const id = setInterval(() => {
      if (statusRef.current === "playing") {
        setPlayback({
          status: "playing",
          arc: arcRef.current,
          elapsedMs: elapsedRef.current,
        });
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  // ── simctl bridge ────────────────────────────────────────────────────────
  // Push the current lat/lng to the simulator on a fixed cadence whenever
  // we're playing. Skipped while paused/idle so the simulator can hold its
  // last position. On stop we run `... clear`.
  useEffect(() => {
    if (playback.status !== "playing") return;
    let cancelled = false;
    let lastPushed = 0;
    let inflight: Promise<unknown> | null = null;

    const push = async () => {
      if (cancelled || inflight) return;
      const now = Date.now();
      if (now - lastPushed < LOCATION_PUSH_INTERVAL_MS) return;
      lastPushed = now;
      const pt = pointAtDistance(trailRef.current, arcRef.current);
      const cmd = `xcrun simctl location ${udid} set ${pt.lat.toFixed(7)},${pt.lng.toFixed(7)}`;
      inflight = exec(cmd).then((res) => {
        if (cancelled) return;
        if (res.exitCode !== 0) {
          setError(parseSimctlError(res.stderr) || "simctl location set failed");
        } else {
          setError(null);
        }
      }).catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }).finally(() => { inflight = null; });
    };

    void push();
    const id = setInterval(push, LOCATION_PUSH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [playback.status, udid, exec]);

  // ── Controls ─────────────────────────────────────────────────────────────
  const onPlayPause = useCallback(() => {
    if (statusRef.current === "playing") {
      statusRef.current = "paused";
      setPlayback((p: PlaybackState) => ({ ...p, status: "paused" }));
      return;
    }
    // Restart from 0 if we ran off the end of a non-loop trail.
    if (arcRef.current >= trailRef.current.totalDistance && !trailRef.current.trail.loop) {
      arcRef.current = 0;
      elapsedRef.current = 0;
    }
    if (sessionOriginRef.current == null) {
      const start = pointAtDistance(trailRef.current, arcRef.current);
      sessionOriginRef.current = { lat: start.lat, lng: start.lng };
    }
    statusRef.current = "playing";
    setPlayback((p: PlaybackState) => ({
      ...p,
      status: "playing",
      arc: arcRef.current,
      elapsedMs: elapsedRef.current,
    }));
  }, []);

  const onStop = useCallback(() => {
    statusRef.current = "idle";
    arcRef.current = 0;
    elapsedRef.current = 0;
    setPlayback(INITIAL_PLAYBACK);
    const origin = sessionOriginRef.current;
    sessionOriginRef.current = null;
    const cmd = origin
      ? `xcrun simctl location ${udid} set ${origin.lat.toFixed(7)},${origin.lng.toFixed(7)}`
      : `xcrun simctl location ${udid} clear`;
    void exec(cmd).then((res) => {
      if (res.exitCode !== 0) setError(parseSimctlError(res.stderr) || null);
      else setError(null);
    });
  }, [exec, udid]);

  const onTrailChange = useCallback((id: string) => {
    setTrailId(id);
    const next = DEFAULT_TRAILS.find((t) => t.id === id);
    if (next) setMode(next.mode);
  }, []);

  // Stop simulating when the panel unmounts so we don't leave the simulator
  // parked on the last waypoint. If we captured a session origin, restore it
  // first so the device lands back where the user started.
  useEffect(() => () => {
    if (statusRef.current === "idle") return;
    const origin = sessionOriginRef.current;
    const cmd = origin
      ? `xcrun simctl location ${udid} set ${origin.lat.toFixed(7)},${origin.lng.toFixed(7)}`
      : `xcrun simctl location ${udid} clear`;
    void exec(cmd).catch(() => {});
  }, [exec, udid]);

  // ── Render ───────────────────────────────────────────────────────────────
  const playing = playback.status === "playing";
  const headerStatus = playing
    ? `${formatDistance(playback.arc)} · ${formatDuration(playback.elapsedMs)}`
    : `${formatDistance(prepared.totalDistance)} total`;

  return (
    <div className="bg-panel border border-white/8 rounded-[10px] flex flex-col gap-2.5 px-3 py-2">
      <style>{HOVER_CSS}</style>
      <button
        type="button"
        onClick={() => setOpen((v: boolean) => !v)}
        className="lem-toggle grid [grid-template-columns:auto_1fr_auto] items-center gap-2 bg-transparent border-none text-white/90 py-2.5 px-1 -my-2 -mx-1 cursor-pointer w-[calc(100%+8px)] text-left min-h-[36px] leading-none"
        aria-expanded={open}
      >
        <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">Location</span>
        <span className="text-[11px] text-white/55 font-mono inline-flex items-center gap-1.5 justify-self-end leading-none">
          <span
            className="size-1.5 rounded-full [transition:background_0.2s,box-shadow_0.2s]"
            style={{
              background: playing ? "#4ade80" : prepared.totalDistance > 0 ? "rgba(255,255,255,0.3)" : "transparent",
              boxShadow: playing ? "0 0 6px rgba(74,222,128,0.7)" : "none",
            }}
          />
          {headerStatus}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <>
          <div className="flex flex-col gap-1">
            <div className="relative block">
              <select
                value={trailId}
                onChange={(e) => onTrailChange((e.target as HTMLSelectElement).value)}
                className="lem-select appearance-none [-webkit-appearance:none] bg-white/[0.04] border border-white/8 rounded-md text-white/90 text-[12px] py-1.5 pr-[26px] pl-2 font-[inherit] cursor-pointer w-full [transition:background_0.12s,border-color_0.12s]"
                aria-label="Trail"
              >
                {DEFAULT_TRAILS.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <span className="absolute right-[9px] top-1/2 -translate-y-1/2 pointer-events-none flex items-center" aria-hidden="true">
                <Chevron open={false} />
              </span>
            </div>
            <div className="text-[10px] text-white/45">{trail.description}</div>
          </div>

          <div className="relative w-full rounded-[10px] overflow-hidden bg-[#0a0a0c] border border-white/[0.06] [aspect-ratio:16/11]">
            <canvas ref={canvasRef} className="w-full h-full block" />
            <ElevationBadges prepared={prepared} />
          </div>

          <div className="grid [grid-template-columns:1fr_1fr_1fr] gap-1.5">
            <Stat label="Distance" value={formatDistance(playback.arc)} />
            <Stat label="Pace" value={formatPace(speedRef.current)} />
            <Stat label="Elapsed" value={formatDuration(playback.elapsedMs)} />
          </div>

          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={onPlayPause}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 border-none rounded-[7px] text-[12px] font-semibold cursor-pointer font-[inherit] ${playing ? "lem-primary lem-primary-on bg-white/[0.16] text-white" : "lem-primary bg-success-emerald text-[#062018]"}`}
              aria-pressed={playing}
              title={playing ? "Pause" : "Play"}
            >
              {playing ? <PauseGlyph /> : <PlayGlyph />}
              <span>{playing ? "Pause" : "Play"}</span>
            </button>
            <button
              type="button"
              onClick={onStop}
              className="lem-ghost flex items-center justify-center gap-1.5 py-2 px-3 border border-white/12 rounded-[7px] text-[12px] font-medium bg-transparent text-white/85 cursor-pointer font-[inherit]"
              disabled={playback.status === "idle" && playback.arc === 0}
              title="Stop and clear simulated location"
            >
              <StopGlyph />
              <span>Stop</span>
            </button>
          </div>

          <div className="flex flex-row items-stretch gap-1.5">
            <div className="flex-1 min-w-0">
              <Segmented
                ariaLabel="Transport mode"
                value={mode}
                onChange={(v) => setMode(v as TrailMode)}
                options={[
                  { value: "walk", label: "Walk", icon: <WalkGlyph /> },
                  { value: "run", label: "Run", icon: <RunGlyph /> },
                  { value: "cycle", label: "Cycle", icon: <CycleGlyph /> },
                  { value: "drive", label: "Drive", icon: <DriveGlyph /> },
                ]}
              />
            </div>
            <button
              type="button"
              onClick={() => {
                const idx = SPEED_MULTIPLIERS.indexOf(multiplier);
                const next = SPEED_MULTIPLIERS[(idx + 1) % SPEED_MULTIPLIERS.length]!;
                setMultiplier(next);
              }}
              className={`flex items-center justify-center gap-1 px-2.5 border rounded-[7px] cursor-pointer font-[inherit] text-[11px] font-semibold min-w-[56px] ${multiplier > 1 ? "lem-speed lem-speed-on bg-white border-white text-[#0a0a0c]" : "lem-speed bg-white/[0.04] border-white/8 text-white/85"}`}
              aria-label={`Speed ${multiplier}× — tap to cycle`}
              title={`Speed ${multiplier}× — tap to cycle`}
            >
              <FastForwardGlyph />
              {multiplier > 1 && <span className="font-mono [font-variant-numeric:tabular-nums]">{multiplier}×</span>}
            </button>
          </div>

          {error && (
            <div className="bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

const Stat = memo(function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-white/[0.03] border border-white/[0.06] rounded-md py-[5px] px-[7px] min-w-0">
      <div className="text-[9px] uppercase tracking-[0.06em] text-white/45">{label}</div>
      <div className="text-[12px] font-mono text-white overflow-hidden text-ellipsis whitespace-nowrap">{value}</div>
    </div>
  );
});

function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex bg-white/[0.04] border border-white/8 rounded-[7px] p-0.5 gap-0.5"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`flex-1 flex items-center justify-center border-none rounded-[5px] py-[5px] px-2 text-[11px] font-medium cursor-pointer font-[inherit] [transition:background_0.12s,color_0.12s] min-h-[22px] ${active ? "lem-seg lem-seg-active bg-white/[0.12] text-white" : "lem-seg bg-transparent text-white/60"}`}
            aria-pressed={active}
            aria-label={o.icon ? o.label : undefined}
            title={o.icon ? o.label : undefined}
          >
            {o.icon ?? o.label}
          </button>
        );
      })}
    </div>
  );
}

function ElevationBadges({ prepared }: { prepared: PreparedTrail }) {
  if (prepared.rawMaxAlt - prepared.rawMinAlt < 5) return null;
  return (
    <>
      <div className="absolute top-2 left-2.5 bg-panel-overlay text-white/85 text-[10px] font-mono px-1.5 py-0.5 rounded-[5px] flex items-center tracking-[0.02em] border border-white/[0.06]">
        <ArrowGlyph dir="up" /> {formatElevation(prepared.rawMaxAlt)}
      </div>
      <div className="absolute top-2 right-2.5 bg-panel-overlay text-white/85 text-[10px] font-mono px-1.5 py-0.5 rounded-[5px] flex items-center tracking-[0.02em] border border-white/[0.06]">
        <ArrowGlyph dir="down" /> {formatElevation(prepared.rawMinAlt)}
      </div>
    </>
  );
}


// ─── Trail morphing ────────────────────────────────────────────────────────
// We don't morph in raw geographic coords — two trails can be hundreds of
// km apart, which makes a per-arc-fraction lerp draw long straight lines
// across the world. Instead we transplant the from-trail into the to-trail's
// frame (center + uniform scale to match planar extent), then find the best
// nearest-neighbour pairing (allowing circular shift for loops, plus a full
// reversal) so each sample's drift is minimised.

const MORPH_SAMPLES = 140;

interface Vec3 { x: number; y: number; z: number }

interface MorphState {
  from: PreparedTrail;
  to: PreparedTrail;
  /** N samples of `from` after being transplanted into `to`'s frame. */
  fromPts: Vec3[];
  /** N samples of `to`, reordered to pair with the same index in fromPts. */
  toPts: Vec3[];
  /** Player position at morph start, transplanted into `to`'s frame. */
  prevMarker: Vec3;
  /** Player target on the new trail (start, since arc resets to 0). */
  nextMarker: Vec3;
  startMs: number;
}

function sampleEvenly(p: PreparedTrail, n: number): Vec3[] {
  const out: Vec3[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1);
    const pt = pointAtDistance(p, f * p.totalDistance);
    out[i] = { x: pt.x, y: pt.y, z: pt.z };
  }
  return out;
}

function buildMorphState(
  from: PreparedTrail,
  fromArc: number,
  to: PreparedTrail,
  startMs: number,
): MorphState {
  const fromCx = (from.bounds.x[0] + from.bounds.x[1]) / 2;
  const fromCz = (from.bounds.z[0] + from.bounds.z[1]) / 2;
  const fromY0 = from.bounds.y[0];
  const fromPlanar = Math.max(
    1, from.bounds.x[1] - from.bounds.x[0], from.bounds.z[1] - from.bounds.z[0],
  );
  const toCx = (to.bounds.x[0] + to.bounds.x[1]) / 2;
  const toCz = (to.bounds.z[0] + to.bounds.z[1]) / 2;
  const toY0 = to.bounds.y[0];
  const toPlanar = Math.max(
    1, to.bounds.x[1] - to.bounds.x[0], to.bounds.z[1] - to.bounds.z[0],
  );
  const scale = toPlanar / fromPlanar;

  const fromRaw = sampleEvenly(from, MORPH_SAMPLES);
  // Transplant from-shape into to's frame.
  const fromPts: Vec3[] = fromRaw.map((p) => ({
    x: (p.x - fromCx) * scale + toCx,
    y: (p.y - fromY0) * scale + toY0,
    z: (p.z - fromCz) * scale + toCz,
  }));
  const toPts = sampleEvenly(to, MORPH_SAMPLES);

  const loop = (from.trail.loop || to.trail.loop) ?? false;
  const aligned = nearestNeighbourAlign(fromPts, toPts, loop);

  // Marker positions, in to's frame so the lerp matches the trail morph.
  const prevWorld = pointAtDistance(from, fromArc);
  const prevMarker: Vec3 = {
    x: (prevWorld.x - fromCx) * scale + toCx,
    y: (prevWorld.y - fromY0) * scale + toY0,
    z: (prevWorld.z - fromCz) * scale + toCz,
  };
  const nextWorld = pointAtDistance(to, 0);
  const nextMarker: Vec3 = { x: nextWorld.x, y: nextWorld.y, z: nextWorld.z };

  return { from, to, fromPts, toPts: aligned, prevMarker, nextMarker, startMs };
}

/** Reorder `to` so that toPts[i] is the best partner for fromPts[i] under a
 *  rigid mapping. Considers a full reverse plus (for loops) any circular
 *  start offset. Quadratic in N but only runs once per trail switch. */
function nearestNeighbourAlign(from: Vec3[], to: Vec3[], loop: boolean): Vec3[] {
  const N = from.length;
  let bestCost = Infinity;
  let bestOffset = 0;
  let bestReversed = false;
  const variants: Vec3[][] = [to, [...to].reverse()];
  for (let v = 0; v < variants.length; v++) {
    const target = variants[v]!;
    const offsetCount = loop ? N : 1;
    for (let k = 0; k < offsetCount; k++) {
      let cost = 0;
      for (let i = 0; i < N; i++) {
        const a = from[i]!;
        const b = target[(i + k) % N]!;
        const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        cost += dx * dx + dy * dy + dz * dz;
        if (cost >= bestCost) break;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestOffset = k;
        bestReversed = v === 1;
      }
    }
  }
  const target = bestReversed ? [...to].reverse() : to;
  const out: Vec3[] = new Array(N);
  for (let i = 0; i < N; i++) out[i] = target[(i + bestOffset) % N]!;
  return out;
}

/** Per-frame lerp using the precomputed morph state. */
function morphFrame(state: MorphState, t: number): PreparedTrail {
  const N = state.fromPts.length;
  const points: RoutePoint[] = new Array(N);
  let arc = 0;
  let prev: RoutePoint | null = null;
  let xMin = Infinity, xMax = -Infinity;
  let yMin = Infinity, yMax = -Infinity;
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < N; i++) {
    const a = state.fromPts[i]!;
    const b = state.toPts[i]!;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const z = a.z + (b.z - a.z) * t;
    if (prev) {
      const dx = x - prev.x, dy = y - prev.y, dz = z - prev.z;
      arc += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const pt: RoutePoint = { x, y, z, arc, lat: 0, lng: 0 };
    points[i] = pt;
    prev = pt;
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    if (z < zMin) zMin = z; if (z > zMax) zMax = z;
  }
  return {
    trail: state.to.trail,
    origin: state.to.origin,
    points,
    totalDistance: arc,
    bounds: { x: [xMin, xMax], y: [yMin, yMax], z: [zMin, zMax] },
    rawMinAlt: state.to.rawMinAlt + (state.from.rawMinAlt - state.to.rawMinAlt) * (1 - t),
    rawMaxAlt: state.to.rawMaxAlt + (state.from.rawMaxAlt - state.to.rawMaxAlt) * (1 - t),
  };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// ─── 3D renderer ───────────────────────────────────────────────────────────

function renderScene(
  canvas: HTMLCanvasElement,
  prepared: PreparedTrail,
  currentArc: number,
  cameraAngle: number,
  timeMs: number,
  moving: boolean,
  markerOverride: Vec3 | null,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Resize to container if needed (HiDPI).
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Background — radial vignette for that "scene viewport" feel.
  const bg = ctx.createRadialGradient(
    cssW * 0.5, cssH * 0.55, Math.min(cssW, cssH) * 0.2,
    cssW * 0.5, cssH * 0.55, Math.max(cssW, cssH) * 0.85,
  );
  bg.addColorStop(0, "#1a1a1d");
  bg.addColorStop(1, "#0a0a0c");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cssW, cssH);

  // Soft dot grid — subtle texture behind the 3D scene for depth cue.
  drawDotGrid(ctx, cssW, cssH);

  const { points, bounds } = prepared;
  if (points.length < 2) return;

  // Camera: orbit around y-axis, fixed 30° down-tilt, orthographic.
  const tiltRad = (28 * Math.PI) / 180;
  const sinT = Math.sin(tiltRad);
  const cosT = Math.cos(tiltRad);
  const sinA = Math.sin(cameraAngle);
  const cosA = Math.cos(cameraAngle);

  const cx = (bounds.x[0] + bounds.x[1]) / 2;
  const cz = (bounds.z[0] + bounds.z[1]) / 2;

  // Find orthographic scale that fits the rotated bbox in the canvas. We use
  // the diagonal of (xExtent, zExtent) since the rotation can swing both
  // dimensions to either screen axis.
  const xExtent = bounds.x[1] - bounds.x[0];
  const zExtent = bounds.z[1] - bounds.z[0];
  const yExtent = bounds.y[1] - bounds.y[0];
  // Vertical extent on screen: tilted route plane (cosT * zExtent) plus
  // elevation projected through sinT.
  const fitW = Math.max(xExtent, zExtent) * 1.05;
  const fitH = Math.max(zExtent * cosT + yExtent * sinT, xExtent * 0.4) * 1.15;
  const padX = cssW * 0.08;
  const padY = cssH * 0.18; // extra room at top for elevation badges
  const scale = Math.min(
    (cssW - padX * 2) / fitW,
    (cssH - padY * 2) / fitH,
  ) * 1.45;

  // Vertical exaggeration — real ridges look pancake-flat in plain ortho,
  // so we push hills harder. Cap at 24× and scale down on big xy extents so
  // flat trails stay flat.
  const elevationGain = yExtent < 1
    ? 1
    : Math.min(24, 140 / Math.max(20, yExtent));

  const project = (x: number, y: number, z: number) => {
    const px = (x - cx);
    const pz = (z - cz);
    // Rotate around y axis.
    const rx = px * cosA + pz * sinA;
    const rz = -px * sinA + pz * cosA;
    // Tilt around x axis (rotate (rz, y) plane).
    const ty = y * elevationGain;
    const sy = ty * cosT - rz * sinT;
    const sz = ty * sinT + rz * cosT;
    return {
      sx: cssW / 2 + rx * scale,
      sy: cssH * 0.55 - sy * scale,
      depth: sz,
    };
  };

  // Project all dense points once. Even on dead-flat trails we want a
  // visible depth band under the line, so clamp the ribbon's bottom edge to
  // at least MIN_DROP_PX below the top edge in screen space.
  const MIN_DROP_PX = 38;
  const projected = points.map((p) => {
    const top = project(p.x, p.y, p.z);
    const ground = project(p.x, 0, p.z);
    const bot = {
      sx: top.sx,
      sy: Math.max(ground.sy, top.sy + MIN_DROP_PX),
      depth: ground.depth,
    };
    return { p, top, bot };
  });

  // Draw the extruded ribbon: per-segment quad with a vertical gradient that
  // fades from the lit top edge into transparent ground.
  for (let i = 1; i < projected.length; i++) {
    const a = projected[i - 1]!;
    const b = projected[i]!;
    const grad = ctx.createLinearGradient(
      (a.top.sx + b.top.sx) / 2,
      (a.top.sy + b.top.sy) / 2,
      (a.bot.sx + b.bot.sx) / 2,
      (a.bot.sy + b.bot.sy) / 2,
    );
    // Stronger elevation gradient — bright lit ridge fading through a mid
    // grey body into a dark ground shadow, so the ribbon reads as a solid
    // wall of terrain rather than a flat band.
    grad.addColorStop(0, "rgba(255,255,255,0.55)");
    grad.addColorStop(0.45, "rgba(180,180,185,0.28)");
    grad.addColorStop(0.85, "rgba(40,40,45,0.18)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(a.top.sx, a.top.sy);
    ctx.lineTo(b.top.sx, b.top.sy);
    ctx.lineTo(b.bot.sx, b.bot.sy);
    ctx.lineTo(a.bot.sx, a.bot.sy);
    ctx.closePath();
    ctx.fill();
  }

  // Top edge — bright crisp line that reads as the elevation profile.
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < projected.length; i++) {
    const { top } = projected[i]!;
    if (i === 0) ctx.moveTo(top.sx, top.sy);
    else ctx.lineTo(top.sx, top.sy);
  }
  ctx.stroke();

  // Travelled portion — thicker, slightly warmer overlay up to currentArc.
  const cutoff = currentArc;
  ctx.strokeStyle = "#f9d2a4";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < projected.length; i++) {
    const { p, top } = projected[i]!;
    if (p.arc > cutoff) break;
    if (!started) { ctx.moveTo(top.sx, top.sy); started = true; }
    else ctx.lineTo(top.sx, top.sy);
  }
  if (started) ctx.stroke();

  // Character marker — dot at the interpolated current position.
  const cur = markerOverride ?? pointAtDistance(prepared, currentArc);
  const m = project(cur.x, cur.y, cur.z);
  // Soft pulse — a single slow ring expanding outward as a filled radial
  // gradient. Slow period and low peak alpha keep it gentle.
  if (moving) {
    const PULSE_PERIOD = 2600;
    const PULSE_MAX = 26;
    const phase = (timeMs % PULSE_PERIOD) / PULSE_PERIOD;
    const r = 4 + (PULSE_MAX - 4) * phase;
    const alpha = 0.22 * (1 - phase);
    const pulse = ctx.createRadialGradient(m.sx, m.sy, r * 0.5, m.sx, m.sy, r);
    pulse.addColorStop(0, `rgba(255,255,255,0)`);
    pulse.addColorStop(0.7, `rgba(255,255,255,${alpha.toFixed(3)})`);
    pulse.addColorStop(1, `rgba(255,255,255,0)`);
    ctx.fillStyle = pulse;
    ctx.beginPath();
    ctx.arc(m.sx, m.sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Body
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(m.sx, m.sy, 3.8, 0, Math.PI * 2);
  ctx.fill();
}

function drawDotGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const spacing = 14;
  const radius = 0.7;
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  for (let y = spacing / 2; y < h; y += spacing) {
    for (let x = spacing / 2; x < w; x += spacing) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ─── Formatting ────────────────────────────────────────────────────────────

function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters.toFixed(0)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatPace(speedMs: number): string {
  if (speedMs <= 0) return "—";
  // Drive speeds: km/h. Walking/running: minutes per km.
  if (speedMs > 7) return `${(speedMs * 3.6).toFixed(0)} km/h`;
  const secPerKm = 1000 / speedMs;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, "0")}/km`;
}

function formatElevation(meters: number): string {
  return `${meters.toFixed(0)} m`;
}

function parseSimctlError(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  // Strip the leading "An error was encountered processing the command" noise.
  const m = trimmed.match(/Reason:\s*(.+)$/m);
  if (m) return m[1]!;
  return trimmed.split("\n").slice(-1)[0] ?? trimmed;
}

