import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
// Type-only: erased from the main bundle. The renderer itself is fetched on
// demand from the server (see loadDevice3DModule) the first time 3D opens.
import type { Device3DHandle, Device3DOptions, ScreenHit } from "../device-3d/index";
import type { DeviceKitChromeDescriptor } from "../utils/grid";
import type { StreamConfig } from "../types";
import { useTheme } from "../hooks/use-theme";
import { simEndpoint } from "../utils/sim-endpoint";
import { FINGER_CURSOR } from "../simulator/SimulatorView";
import {
  screenTouchPayload,
  startsEdgeGesture,
  type ScreenTouch,
  type ScreenUv,
} from "../utils/device-3d-mapping";

export interface Device3DModule {
  mountDevice3D(host: HTMLElement, options: Device3DOptions): Device3DHandle;
}

/** Path of the lazily served 3D chunk, relative to the preview's base path. */
export const DEVICE_3D_CHUNK_PATH = "device-3d.js";

let cachedModule: Promise<Device3DModule> | null = null;

/**
 * Fetch the 3D renderer chunk. Lives outside the inlined preview bundle so the
 * 2D viewer never downloads, parses, or allocates any of it.
 */
export function loadDevice3DModule(): Promise<Device3DModule> {
  if (!cachedModule) {
    const url = simEndpoint(DEVICE_3D_CHUNK_PATH);
    cachedModule = (import(/* @vite-ignore */ url) as Promise<Device3DModule>).catch((error) => {
      cachedModule = null;
      throw error;
    });
  }
  return cachedModule;
}

type Gesture =
  | { kind: "touch"; pointerId: number; uv: ScreenUv; edge: boolean }
  | { kind: "orbit"; pointerId: number; x: number; y: number; t: number; vx: number; vy: number };

export function Device3DView({
  chrome,
  deviceType,
  deviceDegrees,
  streamConfig,
  sourceRoot,
  reducedMotion,
  onTouch,
  onReady,
  onError,
  onClose,
  load = loadDevice3DModule,
}: {
  chrome: DeviceKitChromeDescriptor | null;
  deviceType?: string | null;
  deviceDegrees: number;
  streamConfig: Pick<StreamConfig, "width" | "height" | "orientation"> | null;
  /** Element containing the live 2D stream surface reused as the screen texture. */
  sourceRoot: HTMLElement | null;
  reducedMotion: boolean;
  onTouch: (touch: ScreenTouch) => void;
  onReady?: () => void;
  onError?: (error: unknown) => void;
  onClose: () => void;
  load?: () => Promise<Device3DModule>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<Device3DHandle | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const dark = useTheme().resolved === "dark";

  const latest = useRef({ chrome, deviceType, deviceDegrees, streamConfig, sourceRoot, dark, reducedMotion, onTouch, onReady, onError, onClose });
  latest.current = { chrome, deviceType, deviceDegrees, streamConfig, sourceRoot, dark, reducedMotion, onTouch, onReady, onError, onClose };

  // Mount once the chunk arrives; tear everything down on close.
  useEffect(() => {
    let cancelled = false;
    void load().then(
      (mod) => {
        const host = hostRef.current;
        const l = latest.current;
        if (cancelled || !host || !l.sourceRoot) return;
        try {
          handleRef.current = mod.mountDevice3D(host, {
            chrome: l.chrome,
            deviceType: l.deviceType,
            deviceDegrees: l.deviceDegrees,
            streamConfig: l.streamConfig,
            sourceRoot: l.sourceRoot,
            dark: l.dark,
            reducedMotion: l.reducedMotion,
          });
          l.onReady?.();
        } catch (error) {
          l.onError?.(error);
        }
      },
      (error) => {
        if (!cancelled) latest.current.onError?.(error);
      },
    );
    return () => {
      cancelled = true;
      const gesture = gestureRef.current;
      if (gesture?.kind === "touch") endTouch(gesture);
      gestureRef.current = null;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    handleRef.current?.update({
      chrome,
      deviceType,
      deviceDegrees,
      streamConfig,
      dark,
      reducedMotion,
      ...(sourceRoot ? { sourceRoot } : {}),
    });
  }, [chrome, deviceType, deviceDegrees, streamConfig, sourceRoot, dark, reducedMotion]);

  // Esc leaves 3D. Capture phase so the key isn't also forwarded to the sim.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "keydown") latest.current.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, []);

  function sendTouch(type: ScreenTouch["type"], uv: ScreenUv, edge: boolean) {
    const l = latest.current;
    l.onTouch(screenTouchPayload(type, uv, l.deviceDegrees, l.streamConfig, edge));
  }

  function endTouch(gesture: Extract<Gesture, { kind: "touch" }>) {
    sendTouch("end", gesture.uv, gesture.edge);
  }

  function pick(event: { clientX: number; clientY: number }): ScreenHit | null {
    return handleRef.current?.pick(event.clientX, event.clientY) ?? null;
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || gestureRef.current || !handleRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const hit = pick(event);
    if (hit?.onScreen) {
      const uv = { u: hit.u, v: hit.v };
      const edge = startsEdgeGesture(uv, latest.current.deviceDegrees);
      gestureRef.current = { kind: "touch", pointerId: event.pointerId, uv, edge };
      sendTouch("begin", uv, edge);
      return;
    }
    event.currentTarget.style.cursor = "grabbing";
    gestureRef.current = {
      kind: "orbit",
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      t: event.timeStamp,
      vx: 0,
      vy: 0,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) {
      // Hover: finger over the glass (it taps), grab hand elsewhere (it turns).
      event.currentTarget.style.cursor = pick(event)?.onScreen ? FINGER_CURSOR : "grab";
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "touch") {
      const hit = pick(event);
      if (hit) gesture.uv = { u: hit.u, v: hit.v };
      sendTouch("move", gesture.uv, gesture.edge);
      return;
    }
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    const dt = Math.max(1, event.timeStamp - gesture.t);
    gesture.vx = dx / dt;
    gesture.vy = dy / dt;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    gesture.t = event.timeStamp;
    handleRef.current?.orbitBy(dx, dy);
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    event.currentTarget.style.cursor = "grab";
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (gesture.kind === "touch") {
      const hit = pick(event);
      if (hit) gesture.uv = { u: hit.u, v: hit.v };
      endTouch(gesture);
      return;
    }
    // Only fling a drag that was still moving when released.
    if (event.timeStamp - gesture.t < 80) handleRef.current?.fling(gesture.vx, gesture.vy);
  };

  return (
    <div
      ref={hostRef}
      data-device-3d
      role="img"
      aria-label="3D device view. Drag around the device to turn it; double-click to reset."
      className="absolute select-none"
      style={{
        // Wider than the 2D frame so the device can turn without clipping.
        inset: "0 -22%",
        zIndex: 5,
        touchAction: "none",
        cursor: "grab",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={(event) => {
        if (!pick(event)?.onScreen) handleRef.current?.resetView();
      }}
    />
  );
}
