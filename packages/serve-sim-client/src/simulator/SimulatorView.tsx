import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import type { StreamConfig } from "../types.js";
import {
  HID_EDGE_BOTTOM,
  homeIndicatorEdge,
  rawDeltaForDisplayDelta,
  rawEdgeForDisplayEdge,
  rawPointForDisplayPoint,
  streamDisplayGeometry,
} from "./orientation.js";
import { digitalCrownDeltaFromWheel } from "./digitalCrown.js";
import { wheelDeltaToPixels } from "./scroll-wheel.js";
import { useAvccStream } from "./use-avcc-stream.js";
import { isAvccSupported } from "../avcc-codec.js";

// Custom round cursor matching the finger dot indicator
const FINGER_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='9' fill='rgba(255,255,255,0.45)' stroke='rgba(0,0,0,0.55)' stroke-width='1.25' filter='drop-shadow(0 1px 2px rgba(0,0,0,0.45))'/%3E%3C/svg%3E") 12 12, pointer`;

// Scale applied to the AVCC <canvas> so its antialiased layer edge overshoots
// the surface's overflow:hidden clip (see canvasStyle below). ~0.4% covers a
// 1px seam at any window size while cropping only a sub-pixel of content.
const CANVAS_SEAM_OVERSHOOT = 1.004;

const WS_MSG_TOUCH = 0x03;
const WS_MSG_BUTTON = 0x04;
const WS_MSG_MULTI_TOUCH = 0x05;
const WS_MSG_DIGITAL_CROWN = 0x0a;
const WS_MSG_SCROLL = 0x0b;

export interface SimulatorViewProps {
  /** Base URL of the serve-sim server, e.g. "http://localhost:3100" */
  url: string;
  /** Explicit WebSocket URL. If omitted, derived from `url` by replacing http→ws + "/ws". */
  wsUrl?: string;
  style?: CSSProperties;
  /** Extra style applied to the <img> element rendering the stream. */
  imageStyle?: CSSProperties;
  className?: string;
  /** Called when the home button is pressed. If not provided, sends via WebSocket. */
  onHomePress?: () => void;
  /** Relay mode: callback for touch events (bypasses direct WS) */
  onStreamTouch?: (data: { type: "begin" | "move" | "end"; x: number; y: number; edge?: number }) => void;
  /** Relay mode: callback for multi-touch events */
  onStreamMultiTouch?: (data: { type: "begin" | "move" | "end"; x1: number; y1: number; x2: number; y2: number }) => void;
  /** Relay mode: callback for button events */
  onStreamButton?: (button: string) => void;
  /** Relay mode: callback for Digital Crown rotation events */
  onStreamDigitalCrown?: (delta: number) => void;
  /** Relay mode: callback for scroll-wheel / trackpad pan events. Deltas and the
   * `x`/`y` cursor anchor are a fraction of the display in raw device orientation
   * (positive dy = content down). The anchor is where the pan gesture begins. */
  onStreamScroll?: (data: { dx: number; dy: number; x: number; y: number }) => void;
  /** Enables mouse-wheel/trackpad Digital Crown rotation forwarding. */
  enableDigitalCrown?: boolean;
  /** Relay mode: subscribe to frame updates (bypasses React state for performance).
   * Callback receives a blob URL (object URL) pointing to the JPEG frame. */
  subscribeFrame?: (cb: (blobUrl: string) => void) => () => void;
  /** Relay mode: latest blob URL JPEG frame from the relay (used for initial render) */
  streamFrame?: string | null;
  /** Relay mode: screen config from relay */
  streamConfig?: StreamConfig | null;
  /** Called when the rendered stream reports new dimensions or orientation. */
  onScreenConfigChange?: (config: StreamConfig) => void;
  /** Hide the bottom controls bar (Home button + FPS). */
  hideControls?: boolean;
  /** Called when streaming state changes (true = frames are flowing). */
  onStreamingChange?: (streaming: boolean) => void;
  /** Connection quality indicator: green (good), yellow (degraded), red (poor). */
  connectionQuality?: "good" | "degraded" | "poor" | null;
  /**
   * Video codec preference for the stream:
   * - "avcc" (default): H.264 over `/stream.avcc` decoded with WebCodecs into
   *   a `<canvas>`. Automatically falls back to MJPEG when the browser lacks
   *   `VideoDecoder`.
   * - "mjpeg": force JPEG-per-frame painted into an `<img>`.
   *
   * In relay mode, input is relayed but video can still use AVCC because
   * `useAvcc` and `useAvccStream` only need `url` to read `/stream.avcc`.
   */
  codec?: "mjpeg" | "avcc";
  /**
   * Called when the AVCC (H.264) WebCodecs decoder fails fatally, so the parent
   * can downgrade to MJPEG instead of retrying hardware decode forever. Fires
   * only on the AVCC path; inert under MJPEG.
   */
  onAvccError?: () => void;
}

/**
 * Renders a serve-sim MJPEG stream with touch and gesture input.
 * Connects directly to the serve-sim server (not through the gateway).
 *
 * Touch input is forwarded as normalized (0–1) coordinates over WebSocket.
 * Drags starting in the home-indicator hot zone (see HOME_INDICATOR_BAND_NORM)
 * are sent with `edge: 3` (IndigoHIDEdge bottom), which iOS routes to the
 * system gesture recognizer for interactive swipe-to-home on Face ID devices.
 */
export function SimulatorView({
  url,
  wsUrl: wsUrlProp,
  style,
  imageStyle,
  className,
  onHomePress,
  onStreamTouch,
  onStreamMultiTouch,
  onStreamButton,
  onStreamDigitalCrown,
  onStreamScroll,
  enableDigitalCrown,
  subscribeFrame,
  streamFrame: _streamFrame,
  streamConfig,
  onScreenConfigChange,
  hideControls,
  onStreamingChange,
  connectionQuality,
  codec = "avcc",
  onAvccError,
}: SimulatorViewProps) {
  const relayMode = !!onStreamTouch;
  // AVCC decode is independent of input relay: the H.264 pipeline only needs
  // `url`, so it runs in both direct and relay mode (input still forwards
  // through `onStreamTouch`). Falls back to the <img> when WebCodecs is
  // unavailable or `codec="mjpeg"`.
  const useAvcc = codec === "avcc" && isAvccSupported();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const relayImgRef = useRef<HTMLImageElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const inputLayerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenSize, setScreenSize] = useState<StreamConfig | null>(null);
  const screenSizeRef = useRef<StreamConfig | null>(null);
  const onScreenConfigChangeRef = useRef(onScreenConfigChange);
  onScreenConfigChangeRef.current = onScreenConfigChange;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setViewportSize({ width: rect.width, height: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [fps, setFps] = useState(0);
  const frameCountRef = useRef(0);
  const [showSlowOverlay, setShowSlowOverlay] = useState(false);
  const slowOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show "Slow connection" overlay briefly when quality drops to poor
  useEffect(() => {
    if (connectionQuality === "poor") {
      setShowSlowOverlay(true);
      if (slowOverlayTimerRef.current) clearTimeout(slowOverlayTimerRef.current);
      slowOverlayTimerRef.current = setTimeout(() => {
        setShowSlowOverlay(false);
        slowOverlayTimerRef.current = null;
      }, 3000);
    } else {
      setShowSlowOverlay(false);
      if (slowOverlayTimerRef.current) {
        clearTimeout(slowOverlayTimerRef.current);
        slowOverlayTimerRef.current = null;
      }
    }
    return () => {
      if (slowOverlayTimerRef.current) clearTimeout(slowOverlayTimerRef.current);
    };
  }, [connectionQuality]);

  const streamUrl = `${url}/stream.mjpeg`;

  useEffect(() => {
    screenSizeRef.current = null;
    setScreenSize(null);
  }, [url]);

  const updateScreenConfig = useCallback((config: StreamConfig | null | undefined) => {
    if (!config || config.width <= 0 || config.height <= 0) return;
    const prev = screenSizeRef.current;
    const next =
      config.orientation === undefined && prev?.orientation
        ? { ...config, orientation: prev.orientation }
        : config;
    if (
      prev &&
      prev.width === next.width &&
      prev.height === next.height &&
      prev.orientation === next.orientation
    ) {
      return;
    }
    screenSizeRef.current = next;
    setScreenSize(next);
    onScreenConfigChangeRef.current?.(next);
  }, []);

  // Notify parent when streaming state changes
  const onStreamingChangeRef = useRef(onStreamingChange);
  onStreamingChangeRef.current = onStreamingChange;
  useEffect(() => {
    onStreamingChangeRef.current?.(connected);
  }, [connected]);

  // In relay mode, use streamConfig for screen size
  useEffect(() => {
    if (relayMode && streamConfig) {
      updateScreenConfig(streamConfig);
    }
  }, [relayMode, streamConfig, updateScreenConfig]);

  // In relay mode, subscribe to frames and update img.src directly (bypasses React).
  const connectedRef = useRef(false);
  connectedRef.current = connected;
  // Latest received-but-not-yet-painted frame, and the one currently shown.
  // Painting is drained on requestAnimationFrame (latest wins; stale frames
  // are dropped and their blob URLs released) so a browser that can't keep up
  // never queues an img.src assignment + JPEG decode for every received frame.
  // That per-frame work on the main thread is what freezes weak browsers — the
  // ones without WebCodecs that fall back to this MJPEG path — under the high
  // frame rate of heavy interaction. Mirrors the AVCC canvas single-frame queue.
  const pendingBlobUrlRef = useRef<string | null>(null);
  const paintedBlobUrlRef = useRef<string | null>(null);
  useEffect(() => {
    // AVCC paints the canvas via useAvccStream; skip the MJPEG relay <img>.
    if (!relayMode || !subscribeFrame || useAvcc) return;
    // Startup watchdog: flag the stream as broken if no frame arrives within
    // the window. Catches the silent-failure mode where the helper accepts
    // the MJPEG connection but its underlying simulator was shut down —
    // /stream.mjpeg keeps the socket open forever without emitting bytes.
    const STARTUP_MS = 6000;
    const watchdog = setTimeout(() => {
      if (!connectedRef.current) {
        setError("Stream is not producing frames. The simulator may have stopped — try reconnecting.");
      }
    }, STARTUP_MS);

    let rafId = requestAnimationFrame(function paint() {
      const next = pendingBlobUrlRef.current;
      if (next) {
        pendingBlobUrlRef.current = null;
        const img = relayImgRef.current;
        if (img) {
          // Release the frame we're replacing; its decode is now moot.
          if (paintedBlobUrlRef.current) URL.revokeObjectURL(paintedBlobUrlRef.current);
          paintedBlobUrlRef.current = next;
          img.src = next;
          frameCountRef.current++;
        } else {
          URL.revokeObjectURL(next);
        }
      }
      rafId = requestAnimationFrame(paint);
    });

    const unsubscribe = subscribeFrame((blobUrl) => {
      lastFrameAtRef.current = Date.now();
      // Latest-wins: a frame that arrived since the last paint is now stale —
      // release it so blob URLs don't accumulate between animation frames.
      if (pendingBlobUrlRef.current) URL.revokeObjectURL(pendingBlobUrlRef.current);
      pendingBlobUrlRef.current = blobUrl;
      if (!connectedRef.current) {
        clearTimeout(watchdog);
        setConnected(true);
        setError(null);
      }
    });
    return () => {
      clearTimeout(watchdog);
      cancelAnimationFrame(rafId);
      unsubscribe?.();
      if (pendingBlobUrlRef.current) {
        URL.revokeObjectURL(pendingBlobUrlRef.current);
        pendingBlobUrlRef.current = null;
      }
      if (paintedBlobUrlRef.current) {
        URL.revokeObjectURL(paintedBlobUrlRef.current);
        paintedBlobUrlRef.current = null;
      }
    };
  }, [relayMode, subscribeFrame, useAvcc]);

  // AVCC (H.264) decode → canvas. Inert unless `useAvcc`. Works in both
  // direct and relay mode (it only needs `url`).
  const onAvccFirstFrame = useCallback(() => {
    lastFrameAtRef.current = Date.now();
    setConnected(true);
    setError(null);
  }, []);
  const onAvccFrame = useCallback(() => {
    frameCountRef.current++;
    lastFrameAtRef.current = Date.now();
    // Re-establish "connected" if the relay staleness watchdog tripped during
    // the decoder's startup buffering gap (keyframe + several deltas can land
    // before the first frame is emitted). Mirrors the MJPEG relay path; guarded
    // so it only fires on the false→true transition, not every frame.
    if (!connectedRef.current) {
      setConnected(true);
      setError(null);
    }
  }, []);
  useAvccStream({
    url,
    enabled: useAvcc,
    canvasRef,
    onFirstFrame: onAvccFirstFrame,
    onFrame: onAvccFrame,
    onError: setError,
    onDecoderError: onAvccError,
  });

  const sendTouch = useCallback(
    (touch: {
      type: "begin" | "move" | "end";
      x: number;
      y: number;
      edge?: number;
    }) => {
      const orientation = streamDisplayGeometry(screenSizeRef.current).inputOrientation;
      const point = rawPointForDisplayPoint(orientation, touch.x, touch.y);
      const edge =
        touch.edge === undefined
          ? undefined
          : rawEdgeForDisplayEdge(orientation, touch.edge);
      const payload =
        edge === undefined ? { type: touch.type, ...point } : { type: touch.type, ...point, edge };

      if (relayMode) {
        onStreamTouch?.(payload);
        return;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const json = new TextEncoder().encode(JSON.stringify(payload));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = WS_MSG_TOUCH;
      msg.set(json, 1);
      ws.send(msg);
    },
    [relayMode, onStreamTouch],
  );

  const sendButton = useCallback((button: string) => {
    if (relayMode) {
      onStreamButton?.(button);
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const json = new TextEncoder().encode(JSON.stringify({ button }));
    const msg = new Uint8Array(1 + json.length);
    msg[0] = WS_MSG_BUTTON;
    msg.set(json, 1);
    ws.send(msg);
  }, [relayMode, onStreamButton]);

  const sendDigitalCrown = useCallback((delta: number) => {
    if (!Number.isFinite(delta) || delta === 0) return;
    if (relayMode) {
      onStreamDigitalCrown?.(delta);
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const json = new TextEncoder().encode(JSON.stringify({ delta }));
    const msg = new Uint8Array(1 + json.length);
    msg[0] = WS_MSG_DIGITAL_CROWN;
    msg.set(json, 1);
    ws.send(msg);
  }, [relayMode, onStreamDigitalCrown]);

  const sendScroll = useCallback(
    (dx: number, dy: number, anchorX: number, anchorY: number) => {
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
      // Rotate both the delta and the cursor anchor into raw device orientation so
      // scrolling tracks the visible content on landscape / upside-down devices.
      const orientation = streamDisplayGeometry(screenSizeRef.current).inputOrientation;
      const rawDelta = rawDeltaForDisplayDelta(orientation, dx, dy);
      const rawAnchor = rawPointForDisplayPoint(orientation, anchorX, anchorY);
      const payload = { dx: rawDelta.dx, dy: rawDelta.dy, x: rawAnchor.x, y: rawAnchor.y };
      if (relayMode) {
        onStreamScroll?.(payload);
        return;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const json = new TextEncoder().encode(JSON.stringify(payload));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = WS_MSG_SCROLL;
      msg.set(json, 1);
      ws.send(msg);
    },
    [relayMode, onStreamScroll],
  );

  const sendMultiTouch = useCallback(
    (touch: {
      type: "begin" | "move" | "end";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }) => {
      const orientation = streamDisplayGeometry(screenSizeRef.current).inputOrientation;
      const p1 = rawPointForDisplayPoint(orientation, touch.x1, touch.y1);
      const p2 = rawPointForDisplayPoint(orientation, touch.x2, touch.y2);
      const payload = {
        type: touch.type,
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
      };

      if (relayMode) {
        onStreamMultiTouch?.(payload);
        return;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const json = new TextEncoder().encode(JSON.stringify(payload));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = WS_MSG_MULTI_TOUCH;
      msg.set(json, 1);
      ws.send(msg);
    },
    [relayMode, onStreamMultiTouch],
  );

  useEffect(() => {
    // In relay mode, skip direct WS/MJPEG connections
    if (relayMode) return;

    // Connect WebSocket for touch input. The same socket also carries
    // server->client screen-config pushes (tag 0x82), so direct consumers follow
    // dimension/orientation changes without polling /config.
    const wsUrl = wsUrlProp ?? url.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(ev.data);
      if (bytes.length < 1 || bytes[0] !== 0x82) return;
      try {
        updateScreenConfig(JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as StreamConfig);
      } catch {}
    };

    ws.onopen = () => {
      if (!useAvcc) setConnected(true);
      setError(null);
    };
    ws.onclose = () => {
      setConnected(false);
    };
    ws.onerror = () => {
      setError("WebSocket connection failed");
      setConnected(false);
    };

    // FPS counter: read MJPEG boundary markers
    const fpsAbort = new AbortController();
    const fpsInterval = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);

    // Startup watchdog: if we open the MJPEG socket but never see a frame
    // boundary, surface a real error instead of leaving the user staring at
    // a blank <img>. This catches the "helper bound to shutdown sim" case
    // where bytes never arrive.
    // In AVCC mode the decode hook owns the /stream.avcc connection and frame
    // accounting, so skip the MJPEG reader + its watchdog entirely.
    let sawAnyFrame = false;
    const startupWatchdog = useAvcc
      ? null
      : setTimeout(() => {
          if (!sawAnyFrame) {
            setError("Stream is not producing frames. The simulator may have stopped — try reconnecting.");
          }
        }, 6000);

    if (!useAvcc) (async () => {
      try {
        const res = await fetch(streamUrl, { signal: fpsAbort.signal });
        const reader = res.body?.getReader();
        if (!reader) return;
        const boundary = new TextEncoder().encode("--frame");
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            for (let i = 0; i <= value.length - boundary.length; i++) {
              let match = true;
              for (let j = 0; j < boundary.length; j++) {
                if (value[i + j] !== boundary[j]) {
                  match = false;
                  break;
                }
              }
              if (match) {
                frameCountRef.current++;
                if (!sawAnyFrame) {
                  sawAnyFrame = true;
                  if (startupWatchdog) clearTimeout(startupWatchdog);
                }
              }
            }
          }
        }
      } catch {
        // aborted on cleanup
      }
    })();

    return () => {
      fpsAbort.abort();
      clearInterval(fpsInterval);
      if (startupWatchdog) clearTimeout(startupWatchdog);
      ws.close();
      wsRef.current = null;
    };
  }, [url, streamUrl, relayMode, updateScreenConfig, wsUrlProp, useAvcc]);

  // FPS counter + stale-frame detection for relay mode.
  // Unlike non-relay mode (where WS close flips connected=false), relay mode
  // only knows the stream is alive when frames arrive. Without this, killing
  // the upstream helper leaves the UI stuck on "live" forever.
  const lastFrameAtRef = useRef(0);
  useEffect(() => {
    if (!relayMode) return;
    const STALE_MS = 2000;
    const checkStaleness = () => {
      const last = lastFrameAtRef.current;
      if (!last || !connectedRef.current) return;
      if (Date.now() - last > STALE_MS) setConnected(false);
    };
    const interval = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
      checkStaleness();
    }, 1000);
    // Also run when the tab becomes visible again — background tabs throttle
    // setInterval, so without this the indicator can stay stuck on "live"
    // after the user refocuses a tab whose stream died in the background.
    const onVis = () => { if (!document.hidden) checkStaleness(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [relayMode]);

  const getViewElement = useCallback(() => {
    if (useAvcc) return canvasRef.current;
    return relayMode ? relayImgRef.current : imgRef.current;
  }, [relayMode, useAvcc]);

  const getInputRect = useCallback(() => {
    return surfaceRef.current?.getBoundingClientRect()
      ?? getViewElement()?.getBoundingClientRect()
      ?? null;
  }, [getViewElement]);

  const handleTouch = useCallback(
    (type: "begin" | "move" | "end", event: MouseEvent<HTMLElement>) => {
      const rect = getInputRect();
      if (!rect) return;
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      sendTouch({ type, x, y });
    },
    [getInputRect, sendTouch],
  );

  const handleDigitalCrownWheelDelta = useCallback(
    (deltaY: number, deltaMode: number) => {
      const rect = getInputRect();
      const pageHeight = rect?.height || 1;
      const delta = digitalCrownDeltaFromWheel(deltaY, deltaMode, pageHeight);
      if (delta === null) return false;
      sendDigitalCrown(delta);
      return true;
    },
    [getInputRect, sendDigitalCrown],
  );


  // Bottom-edge gesture: forward touches with edge=3 (bottom) so iOS
  // handles the interactive home indicator animation natively.
  const edgeGestureRef = useRef(false);

  // Multi-touch state (mouse Alt+click and real touch)
  const multiTouchActiveRef = useRef(false);
  const multiTouchShiftRef = useRef(false);
  // For pan mode: the fixed offset from finger1 to finger2
  const panOffsetRef = useRef({ dx: 0, dy: 0 });
  // Track whether real multi-touch (2+ fingers) is active
  const realMultiTouchRef = useRef(false);
  const [altHeld, setAltHeld] = useState(false);
  const lastMousePosRef = useRef({ x: 0.5, y: 0.5 });
  const [fingerIndicators, setFingerIndicators] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);

  // Track Alt key globally to show preview before click
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        setAltHeld(false);
        if (!multiTouchActiveRef.current) {
          setFingerIndicators(null);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Show preview indicators when Alt is held but no gesture is active
  useEffect(() => {
    if (altHeld && !multiTouchActiveRef.current) {
      const pos = lastMousePosRef.current;
      setFingerIndicators({
        x1: pos.x,
        y1: pos.y,
        x2: 1.0 - pos.x,
        y2: 1.0 - pos.y,
      });
    } else if (!altHeld && !multiTouchActiveRef.current) {
      setFingerIndicators(null);
    }
  }, [altHeld]);

  // Single-touch indicator: rendered via ref + direct DOM manipulation for perf
  const touchIndicatorRef = useRef<HTMLDivElement | null>(null);
  const touchActiveRef = useRef(false);
  const rafIdRef = useRef<number>(0);

  const showTouchIndicator = useCallback((x: number, y: number) => {
    touchActiveRef.current = true;
    const el = touchIndicatorRef.current;
    if (el) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        el.style.left = `${x * 100}%`;
        el.style.top = `${y * 100}%`;
        el.style.display = "block";
      });
    }
  }, []);

  const moveTouchIndicator = useCallback((x: number, y: number) => {
    if (!touchActiveRef.current) return;
    const el = touchIndicatorRef.current;
    if (el) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        el.style.left = `${x * 100}%`;
        el.style.top = `${y * 100}%`;
      });
    }
  }, []);

  const hideTouchIndicator = useCallback(() => {
    touchActiveRef.current = false;
    const el = touchIndicatorRef.current;
    if (el) {
      cancelAnimationFrame(rafIdRef.current);
      el.style.display = "none";
    }
  }, []);

  // Scroll-to-pan: mouse-wheel/trackpad scrolling over the device is forwarded
  // as a native scroll event so iOS pans content exactly as it would for a
  // physical scroll wheel — no synthesized finger drag.
  const handleScrollWheel = useCallback(
    (event: globalThis.WheelEvent) => {
      // Don't fight an in-progress pointer/touch drag on the same surface.
      if (touchActiveRef.current || multiTouchActiveRef.current) return false;
      const rect = getInputRect();
      if (!rect) return false;
      const dxPx = wheelDeltaToPixels(event.deltaX, event.deltaMode, rect.width);
      const dyPx = wheelDeltaToPixels(event.deltaY, event.deltaMode, rect.height);
      if (dxPx === 0 && dyPx === 0) return false;
      // Anchor the pan under the cursor so iOS pans the view beneath the pointer
      // (e.g. a bottom sheet vs. the map behind it), clamped to the display.
      const anchorX = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
      const anchorY = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);
      // Express the delta as a fraction of the rendered display so the server can
      // rescale to the device's pixel dimensions. Browser wheel deltas already
      // reflect the user's natural-scroll setting, so the sign passes straight
      // through to match a real scroll wheel.
      sendScroll(dxPx / rect.width, dyPx / rect.height, anchorX, anchorY);
      return true;
    },
    [getInputRect, sendScroll],
  );

  useEffect(() => {
    const el = inputLayerRef.current;
    if (!el) return;

    const onWheel = (event: globalThis.WheelEvent) => {
      const handled = enableDigitalCrown
        ? handleDigitalCrownWheelDelta(event.deltaY, event.deltaMode)
        : handleScrollWheel(event);
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [enableDigitalCrown, handleDigitalCrownWheelDelta, handleScrollWheel]);

  const lastHomeClickRef = useRef(0);
  const homeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleHomeClick = useCallback(() => {
    const now = Date.now();
    const timeSinceLast = now - lastHomeClickRef.current;
    lastHomeClickRef.current = now;

    if (timeSinceLast < 300) {
      if (homeTimerRef.current) {
        clearTimeout(homeTimerRef.current);
        homeTimerRef.current = null;
      }
      if (onHomePress) onHomePress();
      else sendButton("app_switcher");
    } else {
      homeTimerRef.current = setTimeout(() => {
        if (onHomePress) onHomePress();
        else sendButton("home");
        homeTimerRef.current = null;
      }, 300);
    }
  }, [sendButton, onHomePress]);

  // Compute the exact box that fits the stream's aspect ratio inside the
  // viewport, so the <img> matches the video 1:1 (no letterbox, no clipping).
  const streamGeometry = streamDisplayGeometry(screenSize);
  const displayScreenSize = streamGeometry.displayConfig;
  const fittedBox = (() => {
    if (!displayScreenSize || !viewportSize) return null;
    if (viewportSize.width === 0 || viewportSize.height === 0) return null;
    const scale = Math.min(
      viewportSize.width / displayScreenSize.width,
      viewportSize.height / displayScreenSize.height,
    );
    return {
      width: displayScreenSize.width * scale,
      height: displayScreenSize.height * scale,
    };
  })();
  const rotationDegrees = streamGeometry.rotationDegrees;
  const rotatesSideways = streamGeometry.needsCssRotation && Math.abs(rotationDegrees) === 90;
  const clipStyle = imageStyle as (CSSProperties & { cornerShape?: string }) | undefined;
  const streamImageStyle = {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: rotatesSideways && fittedBox ? `${fittedBox.height}px` : "100%",
    height: rotatesSideways && fittedBox ? `${fittedBox.width}px` : "100%",
    transform: `translate(-50%, -50%)${
      rotationDegrees === 0 ? "" : ` rotate(${rotationDegrees}deg)`
    }`,
    transformOrigin: "center center",
    cursor: FINGER_CURSOR,
    display: "block",
    userSelect: "none",
    WebkitUserSelect: "none",
    touchAction: "none",
    ...imageStyle,
    ...(rotationDegrees === 0
      ? {}
      : { borderRadius: 0, cornerShape: undefined }),
  } as CSSProperties;

  // A <canvas> is composited as its own GPU layer; when that layer lands on a
  // fractional device-pixel offset (the surface is centered in the viewport at
  // a sub-pixel x), its downscaled texture edge antialiases against the
  // backdrop and shows as a ~1px light seam along the top/right. The <img>
  // paths paint into the parent layer and never seam, so this only affects the
  // AVCC canvas. Overshoot by a hair so the seam falls outside the surface's
  // overflow:hidden clip; the crop is a sub-pixel of content, invisible next
  // to the rounded-corner mask.
  const canvasStyle: CSSProperties = {
    ...streamImageStyle,
    transform: `${streamImageStyle.transform ?? ""} scale(${CANVAS_SEAM_OVERSHOOT})`,
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        ...(hideControls ? {} : { border: "1px solid rgba(255,255,255,0.12)" }),
        overflow: "hidden",
        minWidth: 0,
        minHeight: 0,
        ...style,
      }}
      className={className}
    >
      <div
        ref={viewportRef}
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          ref={surfaceRef}
          style={{
            position: "relative",
            width: fittedBox ? `${fittedBox.width}px` : "100%",
            height: fittedBox ? `${fittedBox.height}px` : "100%",
            overflow: "hidden",
            borderRadius: clipStyle?.borderRadius,
            cornerShape: clipStyle?.cornerShape,
          } as CSSProperties}
        >
        {useAvcc ? (
          <canvas ref={canvasRef} style={canvasStyle} />
        ) : (
          <img
            ref={imgRef}
            src={relayMode ? undefined : streamUrl}
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                updateScreenConfig({ width: el.naturalWidth, height: el.naturalHeight });
              }
            }}
            style={relayMode ? { display: "none" } : streamImageStyle}
          />
        )}
        {relayMode && !useAvcc && (
          <img
            ref={relayImgRef}
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                updateScreenConfig({ width: el.naturalWidth, height: el.naturalHeight });
              }
            }}
            style={streamImageStyle}
          />
        )}
        {/* Interactive overlay — captures all pointer events */}
        <div
          ref={inputLayerRef}
          style={{
            position: "absolute",
            inset: 0,
            cursor: FINGER_CURSOR,
            touchAction: "none",
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            const rect = getInputRect();
            if (!rect) return;
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;

            if (e.altKey) {
              // Multi-touch mode: begin gesture
              multiTouchActiveRef.current = true;
              multiTouchShiftRef.current = e.shiftKey;
              const fingers = { x1: x, y1: y, x2: 1.0 - x, y2: 1.0 - y };
              // For pan mode, lock the offset between fingers
              panOffsetRef.current = { dx: 1.0 - x - x, dy: 1.0 - y - y };
              setFingerIndicators(fingers);
              sendMultiTouch({ type: "begin", ...fingers });
              return;
            }

            showTouchIndicator(x, y);
            const edge = homeIndicatorEdge(y);
            if (edge !== undefined) {
              edgeGestureRef.current = true;
              sendTouch({ type: "begin", x, y, edge });
            } else {
              edgeGestureRef.current = false;
              handleTouch("begin", e);
            }
          }}
          onMouseMove={(e) => {
            const rect = getInputRect();
            if (!rect) return;
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;
            lastMousePosRef.current = { x, y };

            // Alt-hover preview (no buttons pressed)
            if (e.buttons === 0) {
              if (e.altKey) {
                setFingerIndicators({
                  x1: x,
                  y1: y,
                  x2: 1.0 - x,
                  y2: 1.0 - y,
                });
              }
              return;
            }

            if (multiTouchActiveRef.current) {
              let fingers;
              if (multiTouchShiftRef.current) {
                // Pan: both fingers translate together, maintaining fixed spacing
                const off = panOffsetRef.current;
                fingers = { x1: x, y1: y, x2: x + off.dx, y2: y + off.dy };
              } else {
                // Pinch: fingers mirror around screen center (0.5, 0.5)
                fingers = { x1: x, y1: y, x2: 1.0 - x, y2: 1.0 - y };
              }
              setFingerIndicators(fingers);
              sendMultiTouch({ type: "move", ...fingers });
              return;
            }

            moveTouchIndicator(x, y);
            if (edgeGestureRef.current) {
              sendTouch({ type: "move", x, y, edge: HID_EDGE_BOTTOM });
            } else {
              handleTouch("move", e);
            }
          }}
          onMouseUp={(e) => {
            if (multiTouchActiveRef.current) {
              const rect = getInputRect();
              if (rect) {
                const x = (e.clientX - rect.left) / rect.width;
                const y = (e.clientY - rect.top) / rect.height;
                if (multiTouchShiftRef.current) {
                  const off = panOffsetRef.current;
                  sendMultiTouch({
                    type: "end",
                    x1: x,
                    y1: y,
                    x2: x + off.dx,
                    y2: y + off.dy,
                  });
                } else {
                  sendMultiTouch({
                    type: "end",
                    x1: x,
                    y1: y,
                    x2: 1.0 - x,
                    y2: 1.0 - y,
                  });
                }
              }
              multiTouchActiveRef.current = false;
              // Keep showing preview if alt is still held
              if (!e.altKey) setFingerIndicators(null);
              return;
            }

            hideTouchIndicator();
            if (edgeGestureRef.current) {
              const rect = getInputRect();
              if (rect) {
                const x = (e.clientX - rect.left) / rect.width;
                const y = (e.clientY - rect.top) / rect.height;
                sendTouch({ type: "end", x, y, edge: HID_EDGE_BOTTOM });
              }
              edgeGestureRef.current = false;
              return;
            }
            handleTouch("end", e);
          }}
          onMouseLeave={(e) => {
            if (multiTouchActiveRef.current) {
              if (fingerIndicators) {
                sendMultiTouch({ type: "end", ...fingerIndicators });
              }
              multiTouchActiveRef.current = false;
              setFingerIndicators(null);
              return;
            }

            hideTouchIndicator();
            if (edgeGestureRef.current) {
              const rect = getInputRect();
              if (rect) {
                const x = (e.clientX - rect.left) / rect.width;
                const y = (e.clientY - rect.top) / rect.height;
                sendTouch({ type: "end", x, y, edge: HID_EDGE_BOTTOM });
              }
              edgeGestureRef.current = false;
              return;
            }
            if (e.buttons > 0) handleTouch("end", e);
            setFingerIndicators(null);
          }}
          onTouchStart={(e) => {
            e.preventDefault();
            const rect = getInputRect();
            if (!rect) return;

            if (e.touches.length >= 2) {
              // Two fingers down — start multi-touch
              hideTouchIndicator();
              const t1 = e.touches[0]!;
              const t2 = e.touches[1]!;
              const fingers = {
                x1: (t1.clientX - rect.left) / rect.width,
                y1: (t1.clientY - rect.top) / rect.height,
                x2: (t2.clientX - rect.left) / rect.width,
                y2: (t2.clientY - rect.top) / rect.height,
              };
              // If a single-touch gesture was already in progress, end it first
              if (!realMultiTouchRef.current && !edgeGestureRef.current) {
                sendTouch({ type: "end", x: fingers.x1, y: fingers.y1 });
              }
              realMultiTouchRef.current = true;
              multiTouchActiveRef.current = true;
              edgeGestureRef.current = false;
              setFingerIndicators(fingers);
              sendMultiTouch({ type: "begin", ...fingers });
              return;
            }

            const touch = e.touches[0];
            if (!touch) return;
            const x = (touch.clientX - rect.left) / rect.width;
            const y = (touch.clientY - rect.top) / rect.height;
            showTouchIndicator(x, y);
            const edge = homeIndicatorEdge(y);
            if (edge !== undefined) {
              edgeGestureRef.current = true;
              sendTouch({ type: "begin", x, y, edge });
            } else {
              edgeGestureRef.current = false;
              sendTouch({ type: "begin", x, y });
            }
          }}
          onTouchMove={(e) => {
            e.preventDefault();
            const rect = getInputRect();
            if (!rect) return;

            if (realMultiTouchRef.current && e.touches.length >= 2) {
              const t1 = e.touches[0]!;
              const t2 = e.touches[1]!;
              const fingers = {
                x1: (t1.clientX - rect.left) / rect.width,
                y1: (t1.clientY - rect.top) / rect.height,
                x2: (t2.clientX - rect.left) / rect.width,
                y2: (t2.clientY - rect.top) / rect.height,
              };
              setFingerIndicators(fingers);
              sendMultiTouch({ type: "move", ...fingers });
              return;
            }

            const touch = e.touches[0];
            if (!touch) return;
            const x = (touch.clientX - rect.left) / rect.width;
            const y = (touch.clientY - rect.top) / rect.height;
            moveTouchIndicator(x, y);
            if (edgeGestureRef.current) {
              sendTouch({ type: "move", x, y, edge: HID_EDGE_BOTTOM });
            } else {
              sendTouch({ type: "move", x, y });
            }
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            const rect = getInputRect();
            if (!rect) return;

            if (realMultiTouchRef.current) {
              // End multi-touch when all fingers lift (touches.length is remaining fingers)
              if (e.touches.length < 2) {
                const t1 = e.changedTouches[0];
                // Use last known indicator positions as fallback for the second finger
                const last = fingerIndicators;
                if (t1 && last) {
                  sendMultiTouch({
                    type: "end",
                    x1: (t1.clientX - rect.left) / rect.width,
                    y1: (t1.clientY - rect.top) / rect.height,
                    x2: last.x2,
                    y2: last.y2,
                  });
                } else if (last) {
                  sendMultiTouch({ type: "end", ...last });
                }
                realMultiTouchRef.current = false;
                multiTouchActiveRef.current = false;
                setFingerIndicators(null);
              }
              return;
            }

            const touch = e.changedTouches[0];
            if (!touch) return;
            const x = (touch.clientX - rect.left) / rect.width;
            const y = (touch.clientY - rect.top) / rect.height;
            hideTouchIndicator();
            if (edgeGestureRef.current) {
              sendTouch({ type: "end", x, y, edge: HID_EDGE_BOTTOM });
              edgeGestureRef.current = false;
            } else {
              sendTouch({ type: "end", x, y });
            }
          }}
        />
        {/* Single-touch indicator (hidden by default, shown via ref) */}
        <div
          ref={touchIndicatorRef}
          data-testid="touch-indicator"
          style={{
            position: "absolute",
            display: "none",
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: "rgba(59,130,246,0.5)",
            boxShadow: "0 0 8px rgba(59,130,246,0.3)",
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
          }}
        />
        {/* Multi-touch finger indicators */}
        {fingerIndicators && (
          <>
            <div
              data-testid="finger-dot"
              style={fingerDotStyle(fingerIndicators.x1, fingerIndicators.y1)}
            />
            <div
              data-testid="finger-dot"
              style={fingerDotStyle(fingerIndicators.x2, fingerIndicators.y2)}
            />
          </>
        )}
        {!connected && !error && (
          <div style={{...overlayStyle, ...(imageStyle || {})}}>
            <span style={{ color: "#888", fontSize: 14 }}>Connecting...</span>
          </div>
        )}
        {error && (
          <div style={overlayStyle}>
            <span
              style={{
                color: "#f44",
                fontSize: 14,
                padding: 20,
                textAlign: "center",
              }}
            >
              {error}
            </span>
          </div>
        )}
        {showSlowOverlay && (
          <div style={slowOverlayStyle}>
            <span style={{ color: "#fbbf24", fontSize: 13, fontFamily: "monospace" }}>
              Slow connection
            </span>
          </div>
        )}
        </div>
      </div>
      {!hideControls && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 8px",
            borderTop: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          <button
            onClick={handleHomeClick}
            style={{
              background: "none",
              border: "1px solid rgba(255,255,255,0.2)",
              color: "#aaa",
              fontSize: 11,
              fontFamily: "monospace",
              padding: "2px 10px",
              cursor: "pointer",
              borderRadius: 4,
            }}
          >
            Home
          </button>
          <span
            style={{
              color: fps > 0 ? "#4f4" : "#888",
              fontSize: 12,
              fontFamily: "monospace",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {connectionQuality && (
              <span
                data-testid="quality-dot"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  display: "inline-block",
                  background: connectionQuality === "good" ? "#4ade80" : connectionQuality === "degraded" ? "#facc15" : "#ef4444",
                }}
              />
            )}
            {fps} fps
          </span>
        </div>
      )}
    </div>
  );
}

const slowOverlayStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: "50%",
  transform: "translateX(-50%)",
  background: "rgba(0,0,0,0.7)",
  borderRadius: 6,
  padding: "4px 12px",
  pointerEvents: "none",
};

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.8)",
};

const FINGER_DOT_SIZE = 20;

function fingerDotStyle(x: number, y: number): React.CSSProperties {
  return {
    position: "absolute",
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    width: FINGER_DOT_SIZE,
    height: FINGER_DOT_SIZE,
    borderRadius: "50%",
    background: "rgba(255,255,255,0.45)",
    border: "1.25px solid rgba(0,0,0,0.55)",
    boxShadow: "0 1px 3px rgba(0,0,0,0.45)",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
  };
}
