// Protocol types used by the simulator UI.

export type SimulatorOrientation =
  | "portrait"
  | "portrait_upside_down"
  | "landscape_left"
  | "landscape_right";

export interface StreamConfig {
  width: number;
  height: number;
  /** Last orientation requested through serve-sim, when known. */
  orientation?: SimulatorOrientation;
}

export type ConnectionQuality = "good" | "degraded" | "poor";
export type AdaptiveState = "normal" | "degraded";

export interface StreamAPI {
  start: (options?: { maxFps?: number }) => void;
  stop: () => void;
  sendTouch: (data: { type: "begin" | "move" | "end"; x: number; y: number; edge?: number }) => void;
  sendMultiTouch: (data: { type: "begin" | "move" | "end"; x1: number; y1: number; x2: number; y2: number }) => void;
  sendButton: (button: string) => void;
  sendDigitalCrown?: (delta: number) => void;
  /** Subscribe to frame updates (bypasses React state for performance). Returns unsubscribe fn.
   * Callback receives a blob URL (object URL) pointing to the JPEG frame. */
  subscribeFrame: (cb: (blobUrl: string) => void) => () => void;
  frame: string | null;
  config: StreamConfig | null;
  /** Current adaptive FPS (may change dynamically based on network conditions). */
  adaptiveFps: number;
  /** Adaptive state: "normal" when at full FPS, "degraded" when reduced. */
  adaptiveState: AdaptiveState;
  connectionQuality: ConnectionQuality | null;
}
