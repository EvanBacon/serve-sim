/** Named fold poses. 0° is closed (cover), 180° is flat open (inner). */
export type DevicePoseId = "closed" | "open" | "book" | "tent" | "tabletop";

export type DevicePoseSpec = {
  id: DevicePoseId;
  label: string;
  hingeDegrees: number;
  coverActive: boolean;
  width: number;
  height: number;
};

export const DUO_COVER_SIZE = { width: 1398, height: 2034 } as const;
export const DUO_INNER_SIZE = { width: 2007, height: 2853 } as const;
export const DUO_COVER_ACTIVE_BELOW_DEGREES = 90;

const PRESETS: readonly DevicePoseSpec[] = (
  [
    ["closed", "Closed", 0],
    ["tent", "Tent", 80],
    ["tabletop", "Table", 100],
    ["book", "Book", 130],
    ["open", "Open", 180],
  ] as const
).map(([id, label, hingeDegrees]) => spec(id, label, hingeDegrees));

function spec(id: DevicePoseId, label: string, hingeDegrees: number): DevicePoseSpec {
  const coverActive = hingeDegrees < DUO_COVER_ACTIVE_BELOW_DEGREES;
  const size = coverActive ? DUO_COVER_SIZE : DUO_INNER_SIZE;
  return { id, label, hingeDegrees, coverActive, width: size.width, height: size.height };
}

export function devicePosePresets(): readonly DevicePoseSpec[] {
  return PRESETS;
}

export function resolveDevicePose(raw: string): DevicePoseSpec | null {
  const name = raw.trim().toLowerCase();
  if (name === "cover") return resolveDevicePose("closed");
  if (name === "inner" || name === "openflat" || name === "flat") return resolveDevicePose("open");
  return PRESETS.find((pose) => pose.id === name) ?? null;
}

export function poseForDisplayRole(role: string): DevicePoseSpec | null {
  if (role === "cover") return resolveDevicePose("closed");
  if (role === "inner") return resolveDevicePose("open");
  return null;
}

/** Cover vs inner framebuffer size for a raw hinge angle in degrees. */
export function displaySizeForHingeDegrees(hingeDegrees: number): {
  coverActive: boolean;
  width: number;
  height: number;
} {
  const coverActive = hingeDegrees < DUO_COVER_ACTIVE_BELOW_DEGREES;
  const size = coverActive ? DUO_COVER_SIZE : DUO_INNER_SIZE;
  return { coverActive, width: size.width, height: size.height };
}
