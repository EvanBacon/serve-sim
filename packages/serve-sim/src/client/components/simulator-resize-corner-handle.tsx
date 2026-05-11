// Curved-arc resize affordance anchored to the bottom-right of the simulator
// frame. The SVG owns the pointer surface (with a generous transparent hit
// stroke), and the wrapper div carries the role="separator"/aria for the
// keyboard surface. Visuals: charge sweep on hover/drag, discharge sweep on
// leaving hot state, blurred bloom, per-phase scale/stroke/opacity, and a
// focus ring that follows the arc path.

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEventHandler as ReactAnimationEventHandler,
  type CSSProperties,
  type MouseEventHandler as ReactMouseEventHandler,
  type PointerEventHandler as ReactPointerEventHandler,
  type Ref,
} from "react";
import {
  simulatorResizeCornerArc,
  type DeviceType,
  type StreamConfig,
} from "serve-sim-client/simulator";
import { useSimulatorResize } from "../hooks/use-simulator-resize";
import { usePrefersMoreContrast } from "../hooks/use-prefers-more-contrast";
import { usePrefersReducedMotion } from "../hooks/use-prefers-reduced-motion";
import {
  RESIZE_BLOOM,
  RESIZE_INNER_OPACITY,
  RESIZE_MAIN_OPACITY,
  RESIZE_MAIN_STROKE,
  RESIZE_MAIN_STROKE_W,
  RESIZE_SCALE,
  SIMULATOR_RESIZE_CHARGE_EASE,
  SIMULATOR_RESIZE_CHARGE_MS,
  SIMULATOR_RESIZE_DISCHARGE_MS,
  SIMULATOR_RESIZE_EASE,
  SIMULATOR_RESIZE_EASE_OUT,
  SIMULATOR_RESIZE_HANDLE_DUR_HOT,
  SIMULATOR_RESIZE_HANDLE_DUR_IDLE,
  SIMULATOR_RESIZE_HIT_SLOP,
  SIMULATOR_RESIZE_SPRING,
  sanitizeSvgFragmentId,
  supportsLinearEasing,
  type ResizeVisualPhase,
  type SimulatorResizeArc,
} from "../utils/simulator-resize";

const RESIZE_HANDLE_LIT_SHADOW =
  "drop-shadow(0 0.5px 1px rgba(0,0,0,0.1)) drop-shadow(0 2px 5px rgba(0,0,0,0.13))";
const RESIZE_SOCKET_SHADOW = "drop-shadow(0 1px 1.5px rgba(0,0,0,0.16))";

const RESIZE_DASH_STROKES: [number, string][] = [
  [6, "rgba(160,205,255,0.42)"],
  [4.55, "rgba(255,255,255,0.97)"],
];

function SimulatorResizeArcDashPair({
  dFill,
  w,
  className,
  onEnd,
}: {
  dFill: string;
  w: number;
  className: string;
  onEnd?: ReactAnimationEventHandler<SVGPathElement>;
}) {
  return (
    <>
      {RESIZE_DASH_STROKES.map(([sw, stroke]) => (
        <path
          key={sw}
          className={className}
          d={dFill}
          fill="none"
          pathLength={1}
          stroke={stroke}
          strokeWidth={sw * w}
          strokeLinecap="round"
          onAnimationEnd={onEnd}
        />
      ))}
    </>
  );
}

type SimulatorResizeCornerSvgProps = {
  arc: SimulatorResizeArc;
  phase: ResizeVisualPhase;
  reducedMotion: boolean;
  highContrast: boolean;
  focusVisible: boolean;
  onPointerDown: ReactPointerEventHandler<SVGSVGElement>;
  onPointerMove: ReactPointerEventHandler<SVGSVGElement>;
  onPointerUp: ReactPointerEventHandler<SVGSVGElement>;
  onPointerCancel: ReactPointerEventHandler<SVGSVGElement>;
  onPointerEnter: ReactPointerEventHandler<SVGSVGElement>;
  onPointerLeave: ReactPointerEventHandler<SVGSVGElement>;
  onMouseDown?: ReactMouseEventHandler<SVGSVGElement>;
};

const SimulatorResizeCornerSvg = forwardRef(function SimulatorResizeCornerSvg(
  {
    arc,
    phase,
    reducedMotion,
    highContrast,
    focusVisible,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerEnter,
    onPointerLeave,
    onMouseDown,
  }: SimulatorResizeCornerSvgProps,
  ref: Ref<SVGSVGElement | null>,
) {
  const rawId = useId();
  const fid = sanitizeSvgFragmentId(rawId);
  const filterHover = `serve-sim-rz-bh-${fid}`;
  const filterDrag = `serve-sim-rz-bd-${fid}`;
  const dischargeKf = `serveSimRzDischargeKf${fid}`;
  const dischargeCls = `serveSimRzDischarge${fid}`;

  const isHot = phase !== "idle";
  const wasHotRef = useRef(false);
  const prevHotDischargeRef = useRef(false);
  const chargeEpochRef = useRef(0);
  const [discharging, setDischarging] = useState(false);
  const lastBloomOpacRef = useRef(0.45);
  const dischargeEndsSeenRef = useRef(0);

  if (isHot && !wasHotRef.current) chargeEpochRef.current += 1;
  wasHotRef.current = isHot;

  useLayoutEffect(() => {
    const wasHot = prevHotDischargeRef.current;
    if (wasHot && !isHot) {
      dischargeEndsSeenRef.current = 0;
      setDischarging(true);
    }
    if (isHot) setDischarging(false);
    prevHotDischargeRef.current = isHot;
  }, [isHot]);

  const chargeEpoch = chargeEpochRef.current;
  const chargeKf = `serveSimRzChg_${fid}_${chargeEpoch}`;
  const chargeCls = `serveSimRzChg_${fid}_${chargeEpoch}`;

  const onDischargeAnimEnd = useCallback(() => {
    dischargeEndsSeenRef.current += 1;
    if (dischargeEndsSeenRef.current >= 2) {
      setDischarging(false);
      dischargeEndsSeenRef.current = 0;
    }
  }, []);

  const vw = highContrast ? 1.12 : 1;
  const hitStrokeW = (6 + SIMULATOR_RESIZE_HIT_SLOP * 2) * vw;
  const scale = reducedMotion ? 1 : RESIZE_SCALE[phase];
  const mainStrokeW = RESIZE_MAIN_STROKE_W[phase] * vw;
  const [mainOpHi, mainOpLo] = RESIZE_MAIN_OPACITY[phase];
  const mainOpacity = highContrast ? mainOpHi : mainOpLo;
  const innerOpacity = RESIZE_INNER_OPACITY[phase];
  const bloomOpacity = RESIZE_BLOOM[phase];
  const bloomFilter = phase === "drag" ? `url(#${filterDrag})` : `url(#${filterHover})`;

  useEffect(() => {
    if (isHot) lastBloomOpacRef.current = bloomOpacity;
  }, [isHot, bloomOpacity]);

  const showDashAnim = !reducedMotion && (isHot || discharging);
  const bloomLayerOpacity = isHot ? bloomOpacity : lastBloomOpacRef.current;

  const dur = isHot ? SIMULATOR_RESIZE_HANDLE_DUR_HOT : SIMULATOR_RESIZE_HANDLE_DUR_IDLE;
  const ease = isHot ? SIMULATOR_RESIZE_EASE : SIMULATOR_RESIZE_EASE_OUT;
  // Spring overshoot on the way in; flat ease-out on the way out.
  // Spring is only used when the engine supports `linear()`.
  const scaleEase = isHot && supportsLinearEasing() ? SIMULATOR_RESIZE_SPRING : ease;
  const motionTransform = reducedMotion ? "none" : `transform ${dur} ${scaleEase}`;
  const motionStroke = reducedMotion ? "none" : `opacity ${dur} ${ease}, stroke-width ${dur} ${ease}`;
  const motionRmBloom = reducedMotion ? "none" : `opacity ${dur} ${ease}`;

  const vb = arc.viewBoxSize;
  const d = arc.d;
  const showGlow = !reducedMotion && (isHot || discharging) && bloomLayerOpacity > 0;

  const scaleGroupStyle: CSSProperties = {
    transform: `translate3d(0,0,0) scale(${scale})`,
    transformOrigin: "100% 100%",
    transition: motionTransform,
    willChange: reducedMotion ? undefined : "transform",
    backfaceVisibility: "hidden",
    WebkitBackfaceVisibility: "hidden",
  };

  return (
    <svg
      ref={ref}
      width={vb}
      height={vb}
      viewBox={`0 0 ${vb} ${vb}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      shapeRendering="geometricPrecision"
      style={{
        display: "block",
        overflow: "visible",
        cursor: "nwse-resize",
        touchAction: "none",
        pointerEvents: "auto",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerUp}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onMouseDown={onMouseDown}
    >
      <defs>
        <filter id={filterHover} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation={highContrast ? 0.85 : 1.05} result="b" />
          <feMerge>
            <feMergeNode in="b" />
          </feMerge>
        </filter>
        <filter id={filterDrag} x="-52%" y="-52%" width="204%" height="204%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation={highContrast ? 1.15 : 1.42} result="b" />
          <feMerge>
            <feMergeNode in="b" />
          </feMerge>
        </filter>
        <style type="text/css">
          {`
            ${
              isHot
                ? `
            @keyframes ${chargeKf} {
              from { stroke-dashoffset: 1; }
              to { stroke-dashoffset: 0; }
            }
            .${chargeCls} {
              stroke-dasharray: 1;
              stroke-dashoffset: 1;
              vector-effect: none;
              animation: ${chargeKf} ${SIMULATOR_RESIZE_CHARGE_MS}ms ${SIMULATOR_RESIZE_CHARGE_EASE} forwards;
            }
            `
                : ""
            }
            @keyframes ${dischargeKf} {
              from { stroke-dashoffset: 0; }
              to { stroke-dashoffset: 1; }
            }
            .${dischargeCls} {
              stroke-dasharray: 1;
              stroke-dashoffset: 0;
              vector-effect: none;
              animation: ${dischargeKf} ${SIMULATOR_RESIZE_DISCHARGE_MS}ms ${SIMULATOR_RESIZE_EASE_OUT} forwards;
              animation-fill-mode: both;
            }
          `}
        </style>
      </defs>

      <g aria-hidden="true" style={{ pointerEvents: "none" }}>
        <path
          d={d}
          stroke="rgba(30,32,38,0.5)"
          strokeWidth={5.85 * vw}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{ opacity: 0.28 * 0.32, filter: RESIZE_SOCKET_SHADOW }}
        />
        <path
          d={d}
          stroke="rgba(16,17,22,0.38)"
          strokeWidth={4.6 * vw}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{ opacity: 0.55, filter: RESIZE_SOCKET_SHADOW }}
        />
      </g>

      <g aria-hidden="true" style={{ pointerEvents: "none" }}>
        <path
          d={d}
          fill="none"
          stroke="rgba(10, 132, 255, 0.95)"
          strokeWidth={(SIMULATOR_RESIZE_HIT_SLOP * 2 + 6) * vw}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{
            opacity: focusVisible ? 0.95 : 0,
            transition: reducedMotion
              ? "opacity 80ms linear"
              : `opacity 200ms ${SIMULATOR_RESIZE_EASE_OUT}`,
            filter:
              "drop-shadow(0 0 2px rgba(10,132,255,0.55)) drop-shadow(0 0 4px rgba(10,132,255,0.32))",
          }}
        />
        <path
          d={d}
          fill="none"
          stroke="rgba(255,255,255,0.95)"
          strokeWidth={1.5 * vw}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{
            opacity: focusVisible ? 0.7 : 0,
            transition: reducedMotion
              ? "opacity 80ms linear"
              : `opacity 200ms ${SIMULATOR_RESIZE_EASE_OUT}`,
          }}
        />
      </g>

      <g aria-hidden="true" style={scaleGroupStyle}>
        <g style={{ pointerEvents: "none" }}>
          {showGlow && (
            <path
              d={d}
              stroke="rgba(210,228,255,0.4)"
              strokeWidth={4.25 * vw}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              filter={bloomFilter}
              style={{ opacity: bloomLayerOpacity * 0.82, transition: motionRmBloom }}
            />
          )}
          {reducedMotion && bloomOpacity > 0 && (
            <path
              d={d}
              stroke="rgba(255,255,255,0.82)"
              strokeWidth={4.15 * vw}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              filter={bloomFilter}
              style={{ opacity: bloomOpacity, transition: motionRmBloom }}
            />
          )}
          <path
            d={d}
            stroke={RESIZE_MAIN_STROKE[phase]}
            strokeWidth={mainStrokeW}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            style={{ opacity: mainOpacity, transition: motionStroke, filter: RESIZE_HANDLE_LIT_SHADOW }}
          />
          <path
            d={d}
            stroke="rgba(236,244,252,0.92)"
            strokeWidth={1.38 * vw}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            style={{ opacity: innerOpacity, transition: motionStroke, filter: RESIZE_HANDLE_LIT_SHADOW }}
          />
          {showDashAnim && (
            <g style={{ opacity: bloomLayerOpacity, transition: motionRmBloom }}>
              {isHot && (
                <g key={`rz-charge-${chargeEpoch}`}>
                  <SimulatorResizeArcDashPair dFill={arc.dFill} w={vw} className={chargeCls} />
                </g>
              )}
              {discharging && !isHot && (
                <g key="rz-discharge">
                  <SimulatorResizeArcDashPair
                    dFill={arc.dFill}
                    w={vw}
                    className={dischargeCls}
                    onEnd={onDischargeAnimEnd}
                  />
                </g>
              )}
            </g>
          )}
        </g>
        <path
          d={d}
          fill="none"
          stroke="rgba(0,0,0,0)"
          strokeWidth={hitStrokeW}
          strokeLinecap="round"
          pointerEvents="stroke"
        />
      </g>
    </svg>
  );
});

type SimulatorResize = ReturnType<typeof useSimulatorResize>;

export function SimulatorResizeCornerHandle({
  simulatorResize,
  deviceType,
  streamConfig,
  containerWidth,
  containerHeight,
}: {
  simulatorResize: SimulatorResize;
  deviceType: DeviceType;
  streamConfig:
    | Pick<StreamConfig, "width" | "height" | "orientation">
    | null
    | undefined;
  containerWidth: number;
  containerHeight: number;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const highContrast = usePrefersMoreContrast();
  const [focusVisible, setFocusVisible] = useState(false);

  const arc = useMemo(
    () =>
      simulatorResizeCornerArc({
        type: deviceType,
        config: streamConfig ?? null,
        containerWidth,
        containerHeight,
      }),
    [deviceType, streamConfig, containerWidth, containerHeight],
  );

  const phase: ResizeVisualPhase =
    simulatorResize.isResizing || simulatorResize.isInertia
      ? "drag"
      : simulatorResize.handleHovered
        ? "hover"
        : "idle";

  return (
    <div
      role="separator"
      aria-label="Resize simulator width. Drag the corner or use Left and Right Arrow keys; hold Shift for larger steps."
      aria-orientation="vertical"
      aria-valuemin={Math.round(simulatorResize.minWidth)}
      aria-valuemax={Math.round(simulatorResize.maxWidth)}
      aria-valuenow={Math.round(simulatorResize.committedWidth)}
      tabIndex={0}
      onKeyDown={simulatorResize.onKeyDown}
      onFocus={(e) => {
        setFocusVisible(e.currentTarget.matches?.(":focus-visible") ?? false);
      }}
      onBlur={() => setFocusVisible(false)}
      style={{
        position: "absolute",
        right: -14,
        bottom: -14,
        width: 60,
        height: 60,
        border: "none",
        padding: 0,
        margin: 0,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        background: "transparent",
        pointerEvents: "none",
        outline: "none",
        zIndex: 25,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <SimulatorResizeCornerSvg
        ref={simulatorResize.handleRef}
        arc={arc}
        phase={phase}
        reducedMotion={reducedMotion}
        highContrast={highContrast}
        focusVisible={focusVisible}
        onPointerDown={simulatorResize.onPointerDown}
        onPointerMove={simulatorResize.onPointerMove}
        onPointerUp={simulatorResize.onPointerEnd}
        onPointerCancel={simulatorResize.onPointerEnd}
        onPointerEnter={() => simulatorResize.setHandleHovered(true)}
        onPointerLeave={() => simulatorResize.setHandleHovered(false)}
      />
    </div>
  );
}
