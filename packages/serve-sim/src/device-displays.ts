/** Pixel size of one simulator display, in the device's native framebuffer. */
export type DisplayPixelSize = {
  width: number;
  height: number;
};

export type DeviceDisplayRole = "cover" | "inner" | "display";

/** True when two framebuffer sizes are the same, ignoring rotation. */
export function pixelSizesMatch(a: DisplayPixelSize, b: DisplayPixelSize): boolean {
  return (
    (a.width === b.width && a.height === b.height) ||
    (a.width === b.height && a.height === b.width)
  );
}

/** Cover on a foldable (Device Hub's rest pose), the only screen elsewhere. */
export function defaultDeviceDisplay<T extends DisplayPixelSize>(displays: readonly T[]): T | null {
  if (displays.length === 0) return null;
  return displays.reduce((best, display) =>
    display.width * display.height < best.width * best.height ? display : best,
  );
}

/** Find the display whose native pixels match a live stream, allowing rotation. */
export function matchDeviceDisplay<T extends DisplayPixelSize>(
  displays: readonly T[] | null | undefined,
  width: number,
  height: number,
): T | null {
  if (!displays?.length || !(width > 0) || !(height > 0)) return null;
  const target = { width, height };
  return displays.find((display) => pixelSizesMatch(display, target)) ?? null;
}

/**
 * Two integrated digitizer displays are a foldable: the smaller is the cover
 * (outer) screen, the larger is the inner screen. Anything else stays a generic
 * "display" so a single-screen iPhone is unchanged.
 */
export function rolesForIntegratedDisplays(areas: readonly number[]): DeviceDisplayRole[] {
  if (areas.length !== 2) return areas.map(() => "display");
  return areas[0]! <= areas[1]! ? ["cover", "inner"] : ["inner", "cover"];
}

export function nameForDisplayRole(role: DeviceDisplayRole, fallback = "Display"): string {
  switch (role) {
    case "cover":
      return "Cover";
    case "inner":
      return "Inner";
    default:
      return fallback;
  }
}

/** simctl defaults to the cover even while the inner display is primary. */
export function screenshotDisplayName(role?: DeviceDisplayRole | null): "primary" | "primary-1" | undefined {
  return role === "inner" ? "primary-1" : role === "cover" ? "primary" : undefined;
}
