import type { StreamConfig } from "../types.js";

export type ScreenConfigSource = "external" | "reported";

export interface ScreenConfigUpdate {
  config: StreamConfig;
  notifyParent: boolean;
}

export function resolveScreenConfigUpdate(
  prev: StreamConfig | null,
  config: StreamConfig | null | undefined,
  source: ScreenConfigSource,
): ScreenConfigUpdate | null {
  if (!config || config.width <= 0 || config.height <= 0) return null;
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
    return null;
  }
  return {
    config: next,
    notifyParent: source === "reported",
  };
}
