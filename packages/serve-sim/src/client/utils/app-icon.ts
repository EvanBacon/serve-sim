import type { HostActionFn } from "./exec";

export interface AppDetails {
  bundleId: string;
  isReactNative: boolean;
  pid?: number;
  displayName?: string;
  shortVersion?: string;
  bundleVersion?: string;
  minOS?: string;
  executable?: string;
  appPath?: string;
  iconDataUrl?: string | null;
  loading: boolean;
  error?: string;
}

export async function fetchAppDetails(
  host: HostActionFn,
  udid: string,
  bundleId: string,
): Promise<Partial<AppDetails>> {
  // The server resolves the container, reads Info.plist, and inlines a loose
  // PNG icon if one exists (Assets.car-only icons come back null).
  const res = await host("appDetails", { udid, bundleId });
  if (res.exitCode !== 0) {
    return { error: res.stderr.trim() || "App not found on simulator" };
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    appPath: str(res.appPath),
    displayName: str(res.displayName),
    shortVersion: str(res.shortVersion),
    bundleVersion: str(res.bundleVersion),
    minOS: str(res.minOS),
    executable: str(res.executable),
    iconDataUrl: str(res.iconDataUrl) ?? null,
  };
}

// Process-wide icon cache — keyed by udid:bundleId so a switch between
// devices doesn't reuse stale art. Values are pending fetches OR resolved
// data URLs (or null when no icon could be located).
export const appIconCache = new Map<string, Promise<string | null> | string | null>();

export function fetchAppIcon(
  host: HostActionFn,
  udid: string,
  bundleId: string,
): Promise<string | null> {
  const key = `${udid}:${bundleId}`;
  const existing = appIconCache.get(key);
  if (existing !== undefined) {
    return Promise.resolve(existing as string | null | Promise<string | null>);
  }
  const pending = fetchAppDetails(host, udid, bundleId).then((d) => {
    const url = d.iconDataUrl ?? null;
    appIconCache.set(key, url);
    return url;
  }).catch(() => {
    appIconCache.set(key, null);
    return null;
  });
  appIconCache.set(key, pending);
  return pending;
}
