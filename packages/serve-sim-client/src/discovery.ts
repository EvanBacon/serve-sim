export interface GatewayStatus {
  ok: boolean;
  version: string | null;
  sessions: number;
  maxSessions: number;
  allowlist: string[];
}

export interface DiscoverOptions {
  /** HTTP(S) base URL of the gateway (default: http://localhost:7070) */
  baseUrl?: string;
  /** Timeout in ms for the fetch request (default: 2000) */
  timeout?: number;
}

const DEFAULT_BASE_URL = "http://localhost:7070";
const DEFAULT_TIMEOUT = 2000;

/**
 * Fetch the `/status` endpoint of a gateway server.
 * Returns `null` if the server is unreachable or returns an unexpected response.
 */
export async function fetchGatewayStatus(
  options: DiscoverOptions = {}
): Promise<GatewayStatus | null> {
  const { baseUrl = DEFAULT_BASE_URL, timeout = DEFAULT_TIMEOUT } = options;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/status`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const body = await res.json();
    if (typeof body.ok !== "boolean") return null;

    return body as GatewayStatus;
  } catch {
    return null;
  }
}
