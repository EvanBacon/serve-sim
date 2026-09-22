import type { DuoProjection } from "../../duo-renderer";

/** Resolution changes must not count as model animation. */
export function duoPoseKey(projection: DuoProjection | null) {
  return JSON.stringify(projection && [projection.panel, projection.hingeDegrees, projection.pieces]);
}

/** The native renderer skins and projects the actual hardware button meshes. */
export function duoHardwarePositions(projection: DuoProjection | null) {
  const hardware = projection?.hardware;
  if (!hardware || hardware.length !== 4 || hardware.some(({ x, y, angle }) => ![x, y, angle].every(Number.isFinite))) return [];
  return hardware.map((point, key) => ({ ...point, key }));
}
