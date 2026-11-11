// Viewer preference for DeviceKit chrome (the real-device bezel around the
// live stream). Default is framed whenever chrome data exists. Hiding is
// opt-in via the toolbar / tools panel and is stored in localStorage so a
// phone viewing the preview over Tailscale can drop the nested bezel
// without restarting the helper.
//
// The URL is not a persistence store. An earlier persist path wrote
// `?chrome=0` whenever hide was set (including on mount from localStorage),
// so a one-time hide — or a leftover storage value — stuck in the address
// bar and kept the frame off after reload. We never write `chrome` now, and
// we strip a leftover `?chrome=0` so it cannot keep the bezel off. The
// previous `serve-sim:chrome` key is ignored for the same reason.

export const CHROME_VISIBILITY_STORAGE_KEY = "serve-sim:chrome-v2";

const HIDE_QUERY_VALUES = new Set(["0", "off", "false", "hide", "bare"]);
const SHOW_QUERY_VALUES = new Set(["1", "on", "true", "show"]);

/** Parse `?chrome=` into "user wants chrome hidden", or null if unset/unknown.
 *  Kept for tests and callers that inspect a URL; the live preview no longer
 *  treats the query as a stored preference. */
export function parseChromeHiddenQuery(
  search: string | URLSearchParams | null | undefined,
): boolean | null {
  if (search == null) return null;
  const params = typeof search === "string" ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search) : search;
  const raw = params.get("chrome");
  if (raw == null) return null;
  const value = raw.trim().toLowerCase();
  if (HIDE_QUERY_VALUES.has(value)) return true;
  if (SHOW_QUERY_VALUES.has(value)) return false;
  return null;
}

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
