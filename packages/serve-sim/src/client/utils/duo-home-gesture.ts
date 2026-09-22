import type { StreamConfig } from "../types";
import { HID_EDGE_BOTTOM, HID_EDGE_LEFT, HID_EDGE_RIGHT, HID_EDGE_TOP, homeIndicatorEdge, rawEdgeForDisplayEdge, streamDisplayGeometry } from "../simulator/orientation";

export type DuoTouchPoint = { x: number; y: number; edge?: number };

/** The home indicator follows guest UI orientation, independently of camera roll. */
export function beginDuoTouch(point: DuoTouchPoint, config: StreamConfig): DuoTouchPoint {
  const edge = rawEdgeForDisplayEdge(streamDisplayGeometry(config).inputOrientation, HID_EDGE_BOTTOM);
  const distance = edge === HID_EDGE_LEFT ? 1 - point.x : edge === HID_EDGE_RIGHT ? point.x : edge === HID_EDGE_TOP ? 1 - point.y : point.y;
  return homeIndicatorEdge(distance) === undefined ? point : { ...point, edge };
}

/** A system gesture retains its starting edge through moves, release and cancel. */
export function moveDuoTouch(previous: DuoTouchPoint, point: DuoTouchPoint): DuoTouchPoint {
  return previous.edge === undefined ? point : { ...point, edge: previous.edge };
}
