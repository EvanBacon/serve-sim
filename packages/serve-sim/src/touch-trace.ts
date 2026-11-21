/**
 * Opt-in per-touch trace for diagnosing dropped or misrouted touches
 * (`SERVE_SIM_TOUCH_TRACE=1`). Each server-side touch frame prints one
 * `[touch-trace] server {…}` JSON line with what the client sent, the
 * server's view of the device (size sent to native, orientation, Duo hinge
 * and panels), and the result. The native injector prints matching
 * `[touch-trace] native {…}` lines (Indigo target, channel outcome).
 */

export function touchTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SERVE_SIM_TOUCH_TRACE;
  return value != null && value !== "" && value !== "0" && value !== "false";
}

export interface TouchTraceFields {
  tag: number;
  udid: string;
  /** Raw client payload fields (type, x, y, edge, x1…y2); `ack` included when present. */
  frame: Record<string, unknown>;
  /** Size passed to native (`touchTarget` is chosen from it). */
  width: number;
  height: number;
  orientation: string;
  duo?: {
    hingeDegrees: number | null;
    primaryPanel: string | null;
    activePanel: string;
    followedCover: boolean | null;
  };
  shadowed: boolean | null;
  /** Transport used for the gesture: guest digitizer or legacy Indigo. */
  route?: string | null;
  result: unknown;
  elapsedMs: number;
}

/** The Duo panel the given framebuffer size belongs to, or null for other sizes. */
export function panelForSize(width: number, height: number): "cover" | "inner" | null {
  const [a, b] = [width, height].sort((x, y) => x - y);
  if (a === 1398 && b === 2034) return "cover";
  if (a === 2007 && b === 2853) return "inner";
  return null;
}

export function formatTouchTrace(fields: TouchTraceFields, wall = Date.now()): string {
  const sizePanel = panelForSize(fields.width, fields.height);
  const line = {
    wall: wall / 1000,
    ...fields,
    sizePanel,
    // The native target follows `width`/`height`; flag when that disagrees
    // with the panel the server itself considers active.
    sizeMatchesActivePanel: fields.duo ? sizePanel === fields.duo.activePanel : null,
  };
  return `[touch-trace] server ${JSON.stringify(line)}`;
}
