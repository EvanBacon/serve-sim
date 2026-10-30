/**
 * Display→raw touch remapping for CLI input (`serve-sim tap` / `gesture`).
 *
 * `SimHID.touch` reads x/y in the device's native portrait frame, even after
 * the UI rotates. The web viewer converts with `rawPointForDisplayPoint`; this
 * module reuses that same mapping (and the viewer's decision of *when* to
 * apply it) so a point taken from a landscape screenshot lands on the same
 * spot when sent from the CLI.
 */
import type { SimulatorOrientation, StreamConfig } from "./client/types";
import {
  rawEdgeForDisplayEdge,
  rawPointForDisplayPoint,
  streamDisplayGeometry,
} from "./client/simulator/orientation";

const ORIENTATIONS = new Set<SimulatorOrientation>([
  "portrait",
  "portrait_upside_down",
  "landscape_left",
  "landscape_right",
]);

export interface DisplayTouch {
  type: string;
  x: number;
  y: number;
  edge?: number;
}

/**
 * Orientation to remap CLI touches by, given the server's `/config`. Mirrors
 * the web viewer: remap only when the raw frame is still portrait while the
 * UI is rotated. Returns undefined (no remap) for portrait, for frames that
 * are already landscape, for foldables (a `hingeDegrees` reading means the
 * viewer renders the Duo projection, which sends touches unrotated), and for
 * missing or malformed config.
 */
export function cliInputOrientation(config: unknown): SimulatorOrientation | undefined {
  if (!config || typeof config !== "object") return undefined;
  const c = config as Partial<StreamConfig>;
  if (typeof c.width !== "number" || typeof c.height !== "number") return undefined;
  if (typeof c.hingeDegrees === "number") return undefined;
  const orientation = ORIENTATIONS.has(c.orientation as SimulatorOrientation)
    ? c.orientation
    : undefined;
  return streamDisplayGeometry({ width: c.width, height: c.height, orientation }).inputOrientation;
}

/** Convert one display-space touch to the raw portrait frame `SimHID.touch` expects. */
export function displayTouchToRaw<T extends DisplayTouch>(
  touch: T,
  orientation: SimulatorOrientation | null | undefined,
): T {
  const point = rawPointForDisplayPoint(orientation, touch.x, touch.y);
  const out: T = { ...touch, x: point.x, y: point.y };
  if (typeof touch.edge === "number" && touch.edge !== 0) {
    out.edge = rawEdgeForDisplayEdge(orientation, touch.edge);
  }
  return out;
}

/**
 * `/config` URL for an input target, derived from its HID socket URL
 * (`…/helper/<udid>/ws`). Works for local state files and `--url` remotes.
 */
export function configUrlForWsUrl(wsUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return null;
  }
  if (!url.pathname.endsWith("/ws")) return null;
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.slice(0, -"ws".length) + "config";
  return url.toString();
}
