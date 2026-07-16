// Echoes the request Origin (never a wildcard) when it's loopback or allowlisted.
export function corsAllowOriginHeaders(
  origin: string | null | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> {
  if (!origin) return {};
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return {};
  }
  // URL() keeps IPv6 hosts bracketed ("[::1]"); strip them before comparing.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  // Compare on canonical origins (default port dropped, no trailing slash, host lowercased) so a
  // configured `https://expo.dev:443` or `https://expo.dev/` still matches the browser's Origin.
  // Malformed configured values throw in URL() and are skipped.
  const allowed = allowedOrigins.some((o) => {
    try {
      return new URL(o).origin === parsed.origin;
    } catch {
      return false;
    }
  });
  if (isLoopback || allowed) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return {};
}
