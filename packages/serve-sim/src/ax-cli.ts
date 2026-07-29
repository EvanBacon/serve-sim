import { normalizeAxTree } from "./ax";
import type { RawAxeNode } from "./ax";
import type { AxSnapshot } from "./ax-shared";

/**
 * Map a device's stream URL (`…/helper/<udid>/stream.mjpeg`) to its sibling
 * one-shot accessibility endpoint (`…/helper/<udid>/ax`). The state file only
 * records the stream URL, so the `ax` CLI command derives the endpoint the
 * same way the accessibility-endpoint test does.
 */
export function axUrlFromStreamUrl(streamUrl: string): string {
  return streamUrl.replace(/\/stream\.mjpeg$/, "/ax");
}

/**
 * Fetch the raw axe-shaped tree from a running serve-sim server and normalize
 * it into the flat {@link AxSnapshot} shape the web UI consumes (roles,
 * labels, values, enabled state, frames).
 *
 * Throws with the helper's message when the endpoint reports AX unavailable
 * (503 while the simulator's accessibility framework warms up).
 */
export async function fetchAxSnapshot(streamUrl: string): Promise<AxSnapshot> {
  const res = await fetch(axUrlFromStreamUrl(streamUrl));
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
