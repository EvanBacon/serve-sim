import { shellEscape } from "./exec";

export type LocationPlatform = "ios" | "android";

export interface LocationPoint {
  lat: number;
  lng: number;
}

function coord(value: number): string {
  return value.toFixed(7);
}

export function locationSetCommand(
  platform: LocationPlatform,
  udid: string,
  point: LocationPoint,
): string {
  const lat = coord(point.lat);
  const lng = coord(point.lng);
  if (platform === "android") {
    return `adb -s ${shellEscape(udid)} emu geo fix ${lng} ${lat}`;
  }
  return `xcrun simctl location ${shellEscape(udid)} set ${lat},${lng}`;
}

export function locationClearCommand(
  platform: LocationPlatform,
  udid: string,
): string | null {
  if (platform === "android") return null;
  return `xcrun simctl location ${shellEscape(udid)} clear`;
}
