import { normalizeAxTree } from "./ax";
import type { RawAxeNode } from "./ax";
import type { AxSnapshot } from "./ax-shared";
import { normalizeRef, type AgentSnapshot } from "./ax-refs";

/**
 * Fetch the raw axe-shaped tree from a running serve-sim server's `/ax`
 * endpoint (see {@link axUrlForWsUrl}) and normalize it into the flat
 * {@link AxSnapshot} shape the web UI consumes (roles, labels, values,
 * enabled state, frames). `headers` carries the bearer token for a remote
 * preview.
 *
 * Throws with the helper's message when the endpoint reports AX unavailable
 * (503 while the simulator's accessibility framework warms up).
 */
export async function fetchAxSnapshot(axUrl: string, headers: Record<string, string> = {}): Promise<AxSnapshot> {
  const res = await fetch(axUrl, { headers });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { message?: string };
      if (typeof body?.message === "string" && body.message) message = body.message;
    } catch {}
    throw new Error(message);
  }
  const raw = await res.json() as RawAxeNode[];
  return normalizeAxTree(raw);
}

// ── Agent refs (`serve-sim ax --refs`, `tap @eN`, `settle`) ────────────────

export type AxAgentPath = "snapshot" | "act" | "settle";

function helperUrlForWsUrl(wsUrl: string, suffix: string, params: Record<string, string>): string | null {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return null;
  }
  if (!url.pathname.endsWith("/ws")) return null;
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.slice(0, -"ws".length) + suffix;
  url.search = "";
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Map a device's HID socket URL (`…/helper/<udid>/ws`, local or `--url`
 * remote) to one of its `/ax/*` agent endpoints.
 */
export function axAgentUrlForWsUrl(wsUrl: string, path: AxAgentPath, params: Record<string, string> = {}): string | null {
  return helperUrlForWsUrl(wsUrl, `ax/${path}`, params);
}

/** The same device's one-shot `/ax` tree dump (what plain `serve-sim ax` prints). */
export function axUrlForWsUrl(wsUrl: string): string | null {
  return helperUrlForWsUrl(wsUrl, "ax", {});
}

export type TapTarget =
  | { kind: "ref"; ref: string }
  | { kind: "point"; x: string; y: string | undefined }
  | { kind: "error"; message: string };

/**
 * `serve-sim tap <x> <y>` or `serve-sim tap @e2`. Anything not starting with
 * `@` goes to the unchanged coordinate path (which validates it).
 */
export function parseTapTarget(first: string, second: string | undefined): TapTarget {
  if (!first.trim().startsWith("@")) return { kind: "point", x: first, y: second };
  const ref = normalizeRef(first);
  if (!ref) return { kind: "error", message: `"${first}" is not an element ref (expected e.g. @e2, from \`serve-sim ax --refs\`).` };
  if (second !== undefined) return { kind: "error", message: `tap ${ref} takes no coordinates (got "${second}").` };
  return { kind: "ref", ref };
}

/** `--timeout <ms>`; undefined when not given. Throws on junk. */
export function parseTimeoutOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--timeout must be a non-negative number of milliseconds (got "${value}").`);
  return n;
}

export class AxCliError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "AxCliError";
  }
}

/** GET (or POST `body` as JSON) an `/ax/*` endpoint; non-2xx throws with the server's code and message. */
export async function requestAxAgent(
  url: string,
  opts: { headers: Record<string, string>; body?: unknown; signal?: AbortSignal },
): Promise<unknown> {
  const res = await fetch(url, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: opts.body === undefined ? opts.headers : { ...opts.headers, "Content-Type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const err = json as { error?: unknown; message?: unknown } | null;
    const message = typeof err?.message === "string" && err.message ? err.message : `HTTP ${res.status}`;
    throw new AxCliError(message, res.status, typeof err?.error === "string" ? err.error : undefined);
  }
  return json;
}

/** `serve-sim ax --refs --text`: one line per node. */
export function formatAgentSnapshotText(snapshot: AgentSnapshot): string {
  const lines = [`screen ${snapshot.screen.width}x${snapshot.screen.height}`];
  for (const node of snapshot.nodes) {
    const parts = [node.ref, node.role];
    if (node.label) parts.push(JSON.stringify(node.label));
    if (node.value) parts.push(`= ${JSON.stringify(node.value)}`);
    if (node.enabled === false) parts.push("disabled");
    if (node.offscreen) parts.push("offscreen");
    const f = node.frame;
    parts.push(`(${f.x},${f.y} ${f.w}x${f.h})`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}
