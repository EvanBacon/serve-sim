// Viewer preference for DeviceKit chrome (the real-device bezel around the
// live stream). Default is framed whenever chrome data exists. Hiding is
// opt-in via the toolbar / tools panel and is stored in localStorage so a
// phone viewing the preview over Tailscale can drop the nested bezel
// without restarting the helper.
//
// The URL is not a persistence store. An earlier persist path wrote
// `?chrome=0` whenever hide was set (including on mount from leftover
// localStorage), so a one-time hide — or a leftover storage value — stuck
// in the address bar and kept the frame off after reload. We never write
// `chrome` now, we strip a leftover `?chrome=` (0, 1, or any other value)
// so it cannot keep the bezel off, and we ignore the previous
// `serve-sim:chrome` key for the same reason. Hiding is no longer shareable
// as a URL; use the toolbar toggle.

export const CHROME_VISIBILITY_STORAGE_KEY = "serve-sim:chrome-v2";

export function readChromeHiddenPreference({
  storage,
}: {
  storage?: Pick<Storage, "getItem"> | null;
} = {}): boolean {
  try {
    return storage?.getItem(CHROME_VISIBILITY_STORAGE_KEY) === "hidden";
  } catch {
    return false;
  }
}

export function persistChromeHiddenPreference(
  hideChrome: boolean,
  {
    storage,
    location,
    replaceState,
  }: {
    storage?: Pick<Storage, "setItem"> | null;
    location?: Pick<Location, "href"> | null;
    replaceState?: (url: string) => void;
  } = {},
): void {
  try {
    storage?.setItem(CHROME_VISIBILITY_STORAGE_KEY, hideChrome ? "hidden" : "shown");
  } catch {}
  // Always drop `chrome` from the URL: we never write it, and a leftover
  // `?chrome=0` from the old persist path must not stick.
  if (!location || !replaceState) return;
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has("chrome")) return;
    url.searchParams.delete("chrome");
    replaceState(`${url.pathname}${url.search}${url.hash}`);
  } catch {}
}

/** Whether the live preview should wrap the stream in DeviceKit chrome. The
 *  bezel stays on in every orientation: landscape turns the portrait frame on
 *  its side (see `device-rotation.ts`) rather than dropping it. */
export function shouldUseDeviceChrome({
  hasChrome,
  hideChrome,
}: {
  hasChrome: boolean;
  hideChrome: boolean;
}): boolean {
  return hasChrome && !hideChrome;
}

/** Keep the DeviceKit wrapper mounted whenever chrome *could* be shown.
 *  Hiding the bezel or rotating must not remount the live stream (that
 *  flashes "Connecting…" while the MJPEG/AVCC node reconnects). Only devices
 *  without chrome data stay unwrapped. */
export function shouldWrapDeviceChrome({ hasChrome }: { hasChrome: boolean }): boolean {
  return hasChrome;
}
