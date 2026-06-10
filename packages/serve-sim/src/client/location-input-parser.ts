// Parse a user-pasted string into a lat/lng pair. Accepts raw coordinates,
// full Google / Apple Maps URLs, and short-link forms whose target lives
// behind a redirect — those return `kind: "redirect"` so the UI can resolve
// the final URL server-side (browsers can't follow cross-origin redirects to
// inspect the location).

export type ParseResult =
  | { kind: "coords"; lat: number; lng: number }
  | { kind: "redirect"; url: string }
  | { kind: "error"; message: string };

/** Hosts whose URLs only contain coordinates after a redirect. */
const SHORT_LINK_HOSTS = new Set<string>([
  "maps.app.goo.gl",
  "goo.gl",
  "maps.apple.com",
]);

/** Hosts we recognise as Google Maps long-form URLs. */
const GOOGLE_MAPS_HOSTS = /(^|\.)google\.[^/]+$/i;

const APPLE_MAPS_HOSTS = /(^|\.)apple\.com$/i;

/** Whole-string match for `lat,lng` (signed decimals, optional whitespace). */
const RAW_COORDS_RE =
  /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

const LAT_RANGE = 90;
const LNG_RANGE = 180;

function validCoords(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= LAT_RANGE &&
    Math.abs(lng) <= LNG_RANGE
  );
}

function asCoords(lat: number, lng: number): ParseResult {
  if (!validCoords(lat, lng)) {
    return {
      kind: "error",
      message: `Coordinates out of range (lat ±${LAT_RANGE}, lng ±${LNG_RANGE})`,
    };
  }
  return { kind: "coords", lat, lng };
}

/** Try `lat,lng` as a whole-string match. */
function tryRawCoords(text: string): ParseResult | null {
  const m = RAW_COORDS_RE.exec(text);
  if (!m) return null;
  return asCoords(parseFloat(m[1]!), parseFloat(m[2]!));
}

/** Extract `lat,lng` from the value of a query parameter (e.g. `?q=37.7,-122.4`). */
function tryQueryParamCoords(value: string | null): ParseResult | null {
  if (!value) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(value.trim());
  if (!m) return null;
  return asCoords(parseFloat(m[1]!), parseFloat(m[2]!));
}

/** Google Maps deep-link forms inside the URL path. */
function tryGoogleMapsPath(pathname: string): ParseResult | null {
  // Prefer the !3d/!4d data block over `@LAT,LNG`: when both are present
  // (`/maps/place/<name>/@CAMERA/data=!3dPLACE!4dPLACE`), the @ pin is the
  // camera centre and the !3d/!4d pair is the place centroid — the place
  // centroid is what callers actually want to teleport to.
  let m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(pathname);
  if (m) return asCoords(parseFloat(m[1]!), parseFloat(m[2]!));
  // /maps/@LAT,LNG,ZOOM or /maps/@LAT,LNG (no zoom)
  m = /\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(pathname);
  if (m) return asCoords(parseFloat(m[1]!), parseFloat(m[2]!));
  return null;
}

export function parseLocationInput(raw: string): ParseResult {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "error", message: "Empty input" };

  const direct = tryRawCoords(text);
  if (direct) return direct;

  // Try URL parsing — anything that isn't a URL falls through to the error.
  let url: URL;
  try {
    // Allow `maps.google.com/...` (no scheme) by prefixing https://.
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    url = new URL(candidate);
  } catch {
    return {
      kind: "error",
      message: "Could not parse coordinates — expected lat,lng or a Maps URL",
    };
  }

  const host = url.hostname.toLowerCase();

  // Short links: caller must follow the redirect server-side.
  if (SHORT_LINK_HOSTS.has(host)) {
    // Apple's `maps.apple.com` is BOTH a long-form URL (with ?ll=) and a
    // short-link target — fall through to long-form parsing first, then
    // ask the caller to resolve if nothing matched.
    if (host !== "maps.apple.com") {
      return { kind: "redirect", url: url.toString() };
    }
  }

  // Apple Maps long-form: ?ll=lat,lng or ?coordinate=lat,lng or ?q=lat,lng
  if (APPLE_MAPS_HOSTS.test(host)) {
    const llCoords =
      tryQueryParamCoords(url.searchParams.get("ll")) ||
      tryQueryParamCoords(url.searchParams.get("coordinate")) ||
      tryQueryParamCoords(url.searchParams.get("q"));
    if (llCoords) return llCoords;
    // Apple short-link path like /?address=... with no coords → ask caller
    // to follow the redirect (the resolved URL keeps the ll= param).
    return { kind: "redirect", url: url.toString() };
  }

  // Google Maps long-form: try path patterns first, then common query params.
  if (GOOGLE_MAPS_HOSTS.test(host)) {
    const pathCoords = tryGoogleMapsPath(url.pathname);
    if (pathCoords) return pathCoords;
    const queryCoords =
      tryQueryParamCoords(url.searchParams.get("q")) ||
      tryQueryParamCoords(url.searchParams.get("ll")) ||
      tryQueryParamCoords(url.searchParams.get("center")) ||
      tryQueryParamCoords(url.searchParams.get("destination"));
    if (queryCoords) return queryCoords;
    // Place URLs without coords (e.g. `?q=Tokyo+Tower`) — caller must follow
    // the redirect so the resolved URL's @lat,lng comes through.
    return { kind: "redirect", url: url.toString() };
  }

  return {
    kind: "error",
    message: "Unrecognised Maps URL — paste a Google or Apple Maps link, or raw lat,lng",
  };
}

/** Build the `curl` command that follows a short link to its final URL. We
 *  request `-I` (HEAD) so we only need the headers, `-L` to follow redirects,
 *  `-s` for silent, and `%{url_effective}` to print the resolved URL. */
export function buildRedirectResolveCommand(url: string): string {
  // Single-quote the URL after escaping any embedded single quotes. URLs
  // from URL.toString() never contain single quotes, but defensive anyway.
  const safe = url.replace(/'/g, "'\\''");
  return `curl -sIL -o /dev/null -w '%{url_effective}' --max-time 5 '${safe}'`;
}
