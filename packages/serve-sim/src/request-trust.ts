import { createHash, timingSafeEqual } from "crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "http";

/**
 * Request trust model for the preview server.
 *
 * Trust comes only from the socket: a request is "trusted loopback" when the
 * real TCP peer (for Bun's piped connections, the front server's recorded
 * peer — see {@link registerProxiedPeer}) is a loopback address (127.0.0.0/8
 * or ::1) AND it carries no proxy/forwarding headers (a tunnel or reverse
 * proxy such as ngrok, cloudflared, Tailscale Serve, or nginx connects from
 * loopback but forwards someone else's request, so any proxied request is
 * untrusted).
 *
 * Host and Origin are client-controlled and never grant trust. They are only
 * an additional requirement on top of the socket check: the Host must name a
 * loopback host (defeats DNS rebinding), and state-changing routes and
 * WebSocket upgrades also require a same-origin Origin (CSRF).
 *
 * A raw TCP forward (`ssh -R`, socat) is indistinguishable from a local client
 * at the socket level, so trusted loopback is not enough to run host shell
 * commands: `/exec` is opt-in (`--allow-exec`) and its token is delivered to
 * the CLI through a 0600 file, never through any HTTP response.
 *
 * Everything else is remote. Remote callers must present the auth token
 * configured with `--auth-token` / `SERVE_SIM_AUTH_TOKEN`; without one, remote
 * access is refused. The host shell (`/exec`, `/exec-ws` commands) is never
 * available to remote callers, token or not.
 */

export const AUTH_TOKEN_ENV = "SERVE_SIM_AUTH_TOKEN";
export const AUTH_COOKIE = "serve_sim_auth";
/**
 * Header the preview's auth bootstrap uses to trade the share link's
 * `#token=` fragment for the auth cookie. The token never travels in a URL:
 * request lines end up in server and proxy logs, fragments are never sent.
 */
export const AUTH_EXCHANGE_HEADER = "x-serve-sim-auth";

const FORWARDING_HEADERS = new Set([
  "forwarded",
  "via",
  "x-real-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "true-client-ip",
  "fastly-client-ip",
  "cf-connecting-ip",
  "cf-ray",
]);
const FORWARDING_PREFIXES = ["x-forwarded-", "tailscale-", "ngrok-", "x-original-forwarded"];

/**
 * Under Bun the preview binds a TCP front server that pipes plain HTTP to an
 * internal `node:http` server on 127.0.0.1, so the internal request's socket
 * peer is always loopback. The front server records each piped connection's
 * real peer here, keyed by the internal-side client port.
 */
const proxiedPeers = new Map<number, string>();

export function registerProxiedPeer(internalClientPort: number, peerAddress: string): () => void {
  proxiedPeers.set(internalClientPort, peerAddress);
  return () => {
    if (proxiedPeers.get(internalClientPort) === peerAddress) proxiedPeers.delete(internalClientPort);
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function peerAddress(req: Pick<IncomingMessage, "socket">): string | undefined {
  const socket = req.socket as { remoteAddress?: string; remotePort?: number } | undefined;
  if (!socket) return undefined;
  const remote = socket.remoteAddress;
  if (remote && isLoopbackAddress(remote) && typeof socket.remotePort === "number") {
    const proxied = proxiedPeers.get(socket.remotePort);
    if (proxied) return proxied;
  }
  return remote;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice("::ffff:".length) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Hostname (no port) from a Host header or URL host; brackets kept for IPv6. */
function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  if (!hostname) return false;
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return isLoopbackAddress(hostname);
}

export function hasForwardingHeaders(headers: IncomingHttpHeaders): boolean {
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (FORWARDING_HEADERS.has(lower)) return true;
    if (FORWARDING_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  }
  return false;
}

/** Socket-level trust: the real TCP peer is loopback and nothing forwarded the request. */
function isUnproxiedLoopbackPeer(req: Pick<IncomingMessage, "socket" | "headers">): boolean {
  return isLoopbackAddress(peerAddress(req)) && !hasForwardingHeaders(req.headers);
}

export function isTrustedLoopback(req: Pick<IncomingMessage, "socket" | "headers">): boolean {
  if (!isUnproxiedLoopbackPeer(req)) return false;
  // An additional DNS-rebinding requirement, never a reason to trust. Origin
  // (CSRF) is enforced separately on state-changing routes and upgrades.
  return isLoopbackHostname(hostnameOf(headerValue(req.headers.host)));
}

export type OriginCheck = "absent" | "same" | "cross";

/** Compare the Origin header's host:port with the Host header. */
export function originCheck(req: Pick<IncomingMessage, "headers">): OriginCheck {
  const origin = headerValue(req.headers.origin);
  if (!origin) return "absent";
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "cross";
    const originHost = parsed.host.toLowerCase();
    // A reverse proxy that rewrites Host (e.g. ngrok --host-header=rewrite)
    // reports the public host in X-Forwarded-Host. A victim browser cannot
    // set that header on a cross-site request or WebSocket, so it is safe to
    // accept as an alternative for this CSRF check.
    const hosts = [headerValue(req.headers.host), headerValue(req.headers["x-forwarded-host"])?.split(",")[0]?.trim()];
    return hosts.some((h) => !!h && h.toLowerCase() === originHost) ? "same" : "cross";
  } catch {
    return "cross";
  }
}

/** A browser page served from this loopback server (Origin required). */
export function isLoopbackSameOrigin(req: Pick<IncomingMessage, "headers">): boolean {
  const origin = headerValue(req.headers.origin);
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.host.toLowerCase() !== (headerValue(req.headers.host) ?? "").toLowerCase()) return false;
    return isLoopbackHostname(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function tokensEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Cookie value derived from the token so the raw token never sits in a cookie jar. */
export function authCookieValue(token: string): string {
  return createHash("sha256").update(`serve-sim-auth-cookie:${token}`).digest("base64url");
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function presentsAuthToken(req: Pick<IncomingMessage, "headers">, token: string): boolean {
  const auth = headerValue(req.headers.authorization) ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  if (bearer && tokensEqual(bearer, token)) return true;
  const cookie = cookieValue(headerValue(req.headers.cookie), AUTH_COOKIE);
  return !!cookie && tokensEqual(cookie, authCookieValue(token));
}

export type RemoteAccess =
  | { ok: true }
  | { ok: false; status: 401 | 403; message: string };

/** Decide whether a non-loopback request may reach the preview's routes. */
export function remoteAccess(req: Pick<IncomingMessage, "headers">, authToken: string | undefined): RemoteAccess {
  if (!authToken) {
    return {
      ok: false,
      status: 403,
      message:
        "Remote access is disabled. Start serve-sim with --auth-token <token> " +
        `(or ${AUTH_TOKEN_ENV}) and send it as "Authorization: Bearer <token>".`,
    };
  }
  if (presentsAuthToken(req, authToken)) return { ok: true };
  return { ok: false, status: 401, message: "Missing or invalid serve-sim auth token." };
}

export function resolveAuthToken(explicit: string | undefined): string | undefined {
  const value = (explicit ?? process.env[AUTH_TOKEN_ENV] ?? "").trim();
  return value === "" ? undefined : value;
}
