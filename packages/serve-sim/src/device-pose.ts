/**
 * The Duo's named fold poses, in toolbar order: exactly Closed · Book · Open.
 * 0° is closed (cover), 180° is flat open (inner). This list is the single
 * source of truth for the pose buttons; don't add intermediate hinge presets.
 */
export const DUO_POSES = [
  { id: "closed", label: "Closed", hingeDegrees: 0 },
  { id: "book", label: "Book", hingeDegrees: 130 },
  { id: "open", label: "Open", hingeDegrees: 180 },
] as const;

export type DevicePoseId = (typeof DUO_POSES)[number]["id"];

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

const PRESETS: readonly DevicePoseSpec[] = DUO_POSES.map(({ id, label, hingeDegrees }) => spec(id, label, hingeDegrees));

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

export type DuoPanel = "cover" | "inner";

/**
 * The live panel. SpringBoard's primary-panel readback wins. The 90° hinge
 * rule applies only before that readback exists.
 */
export function duoPanel(input: { primaryPanel?: DuoPanel | null; hingeDegrees?: number | null }): DuoPanel {
  if (input.primaryPanel) return input.primaryPanel;
  return (input.hingeDegrees ?? 0) < DUO_COVER_ACTIVE_BELOW_DEGREES ? "cover" : "inner";
}

export function displaySizeForPanel(panel: DuoPanel): {
  coverActive: boolean;
  width: number;
  height: number;
} {
  const coverActive = panel === "cover";
  const size = coverActive ? DUO_COVER_SIZE : DUO_INNER_SIZE;
  return { coverActive, width: size.width, height: size.height };
}

/** Cover vs inner framebuffer size for a raw hinge angle in degrees. */
export function displaySizeForHingeDegrees(hingeDegrees: number): {
  coverActive: boolean;
  width: number;
  height: number;
} {
  return displaySizeForPanel(duoPanel({ hingeDegrees }));
}
