// Viewer preference for DeviceKit chrome (the real-device bezel around the
// live stream). Default is framed whenever chrome data exists; hiding is
// opt-in so a phone viewing the preview over Tailscale can drop the nested
// bezel without restarting the helper.

export const CHROME_VISIBILITY_STORAGE_KEY = "serve-sim:chrome";

const HIDE_QUERY_VALUES = new Set(["0", "off", "false", "hide", "bare"]);
const SHOW_QUERY_VALUES = new Set(["1", "on", "true", "show"]);

/** Parse `?chrome=` into "user wants chrome hidden", or null if unset/unknown. */
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
  search,
  storage,
}: {
  search?: string | URLSearchParams | null;
  storage?: Pick<Storage, "getItem"> | null;
} = {}): boolean {
  const fromQuery = parseChromeHiddenQuery(search);
  if (fromQuery != null) return fromQuery;
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
  if (!location || !replaceState) return;
  try {
    const url = new URL(location.href);
    const previousSearch = url.search;
    if (hideChrome) url.searchParams.set("chrome", "0");
    else url.searchParams.delete("chrome");
    if (url.search === previousSearch) return;
    replaceState(`${url.pathname}${url.search}${url.hash}`);
  } catch {}
}

/** Whether the live preview should wrap the stream in DeviceKit chrome.
 *  Foldables stay bare: phone14/phone15 bezels are a tall phone opening, and
 *  Duo cover (1398×2034) / inner (2007×2853) panels do not sit in that slot.
 *  The 3D model is the frame for those devices. */
export function shouldUseDeviceChrome({
  hasChrome,
  isLandscape,
  hideChrome,
  multiDisplay = false,
}: {
  hasChrome: boolean;
  isLandscape: boolean;
  hideChrome: boolean;
  multiDisplay?: boolean;
}): boolean {
  return hasChrome && !isLandscape && !hideChrome && !multiDisplay;
}

/** Keep the DeviceKit wrapper mounted whenever chrome *could* be shown.
 *  Hiding the bezel must not remount the live stream (that flashes
 *  "Connecting…" while the MJPEG/AVCC node reconnects). Landscape, foldables,
 *  and devices without chrome data stay unwrapped. */
export function shouldWrapDeviceChrome({
  hasChrome,
  isLandscape,
  multiDisplay = false,
}: {
  hasChrome: boolean;
  isLandscape: boolean;
  multiDisplay?: boolean;
}): boolean {
  return hasChrome && !isLandscape && !multiDisplay;
}
