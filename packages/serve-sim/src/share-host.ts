/** Host part of the share link the CLI prints for a given `--host` bind. */

const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "::0"]);
export const SHARE_HOST_PLACEHOLDER = "<host>";

function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** URL authority form: IPv6 literals get brackets. */
function urlHost(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

/**
 * A specific `--host` address is where clients reach the server, so it is the
 * share host. Only a wildcard bind falls back to the machine's LAN address.
 * A loopback-only bind keeps the placeholder.
 */
export function shareHost(opts: { host: string; exposedToLan: boolean; networkIP: string | null }): string {
  if (!opts.exposedToLan) return SHARE_HOST_PLACEHOLDER;
  const host = unbracket(opts.host.trim());
  if (WILDCARD_HOSTS.has(host)) return opts.networkIP ? urlHost(opts.networkIP) : SHARE_HOST_PLACEHOLDER;
  return urlHost(host);
}
