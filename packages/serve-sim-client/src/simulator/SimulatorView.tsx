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
  rawEdgeForDisplayEdge,
  rawPointForDisplayPoint,
  streamDisplayGeometry,
} from "./orientation.js";

// Custom round cursor matching the finger dot indicator
const FINGER_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='9' fill='rgba(255,255,255,0.45)' stroke='rgba(0,0,0,0.55)' stroke-width='1.25' filter='drop-shadow(0 1px 2px rgba(0,0,0,0.45))'/%3E%3C/svg%3E") 12 12, pointer`;

const WS_MSG_TOUCH = 0x03;
const WS_MSG_BUTTON = 0x04;
const WS_MSG_MULTI_TOUCH = 0x05;

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
}

/**
 * Renders a serve-sim MJPEG stream with touch and gesture input.
 * Connects directly to the serve-sim server (not through the gateway).
 *
 * Touch input is forwarded as normalized (0–1) coordinates over WebSocket.
 * Drags starting in the bottom 12% of the image (y > 0.88) are sent with
 * `edge: 3` (IndigoHIDEdge bottom), which iOS routes to the system gesture
 * recognizer for interactive swipe-to-home on Face ID devices.
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
  subscribeFrame,
  streamFrame,
  streamConfig,
  onScreenConfigChange,
  hideControls,
  onStreamingChange,
  connectionQuality,
}: SimulatorViewProps) {
  const relayMode = !!onStreamTouch;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const relayImgRef = useRef<HTMLImageElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
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

  // In relay mode, subscribe to frames and update img.src directly (bypasses React)
  const connectedRef = useRef(false);
  connectedRef.current = connected;
  const prevBlobUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!relayMode || !subscribeFrame) return;
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
    const unsubscribe = subscribeFrame((blobUrl) => {
      frameCountRef.current++;
      lastFrameAtRef.current = Date.now();
      const img = relayImgRef.current;
      if (img) {
        // Revoke the previous blob URL to avoid memory leaks
        if (prevBlobUrlRef.current) {
          URL.revokeObjectURL(prevBlobUrlRef.current);
        }
        prevBlobUrlRef.current = blobUrl;
        img.src = blobUrl;
      }
      if (!connectedRef.current) {
        clearTimeout(watchdog);
        setConnected(true);
        setError(null);
      }
    });
    return () => {
      clearTimeout(watchdog);
      unsubscribe?.();
      if (prevBlobUrlRef.current) {
        URL.revokeObjectURL(prevBlobUrlRef.current);
        prevBlobUrlRef.current = null;
      }
    };
  }, [relayMode, subscribeFrame]);

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

    // Poll config so direct consumers follow orientation changes even when
    // multipart <img> load events do not fire for each frame.
    const configAbort = new AbortController();
    const fetchConfig = () => {
      fetch(`${url}/config`, { signal: configAbort.signal })
        .then((r) => r.json())
        .then((config: StreamConfig) => {
          updateScreenConfig(config);
        })
        .catch(() => {});
    };
    fetchConfig();
    const configInterval = setInterval(fetchConfig, 1000);

    // Connect WebSocket for touch input
    const wsUrl = wsUrlProp ?? url.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
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
    let sawAnyFrame = false;
    const startupWatchdog = setTimeout(() => {
      if (!sawAnyFrame) {
        setError("Stream is not producing frames. The simulator may have stopped — try reconnecting.");
      }
    }, 6000);

    (async () => {
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
                  clearTimeout(startupWatchdog);
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
      configAbort.abort();
      clearInterval(configInterval);
      clearInterval(fpsInterval);
      clearTimeout(startupWatchdog);
      ws.close();
      wsRef.current = null;
    };
  }, [url, streamUrl, relayMode, updateScreenConfig, wsUrlProp]);

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
    return relayMode ? relayImgRef.current : imgRef.current;
  }, [relayMode]);

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
        {relayMode && (
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
            if (y > 0.88) {
              edgeGestureRef.current = true;
              sendTouch({ type: "begin", x, y, edge: HID_EDGE_BOTTOM });
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
              const t1 = e.touches[0];
              const t2 = e.touches[1];
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
            if (y > 0.88) {
              edgeGestureRef.current = true;
              sendTouch({ type: "begin", x, y, edge: HID_EDGE_BOTTOM });
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
              const t1 = e.touches[0];
              const t2 = e.touches[1];
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
