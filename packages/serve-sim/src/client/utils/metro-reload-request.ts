/** How long to wait for POST /reload before giving up on it. */
const METRO_RELOAD_TIMEOUT_MS = 2500;

/**
 * - `sent`: the server sent a Metro reload (Metro doesn't confirm it).
 * - `not-sent`: the server reports nothing was sent; tap R instead.
 * - `unknown`: no answer in time. The server may still send the reload, so
 *   tapping R too could reload twice.
 */
export type MetroReloadRequestOutcome = "sent" | "not-sent" | "unknown";

/** Ask the serve-sim server to reload `bundleId` through its Metro. */
export async function requestMetroReload(
  endpoint: string,
  bundleId: string,
  {
    fetchImpl = fetch,
    timeoutMs = METRO_RELOAD_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<MetroReloadRequestOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A timeout leaves the server's attempt in flight; a failed request
    // never reached it.
    return (err as { name?: string })?.name === "TimeoutError" ? "unknown" : "not-sent";
  }
  // Errors (and servers without the endpoint) never send a reload.
  if (!res.ok) return "not-sent";
  try {
    const result = (await res.json()) as { sent?: unknown };
    return result.sent === true ? "sent" : "not-sent";
  } catch {
    return "not-sent";
  }
}
