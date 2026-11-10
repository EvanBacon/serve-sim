import { PASTEBOARD_TEXT_LIMIT_BYTES, PASTE_KEY_EVENTS } from "../../pasteboard-shared";

/**
 * Browser half of the Unicode text bridge (#174). The page's keydown
 * forwarding only knows US-keyboard HID usages, so a browser paste (Cmd+V,
 * or Ctrl+V on non-Mac viewers) is sent as text: POST {base}/pasteboard
 * stages it on the guest pasteboard with exact readback, then the page taps
 * Cmd+V in the guest to insert it.
 */

/** How long to wait for the browser's `paste` event after Cmd/Ctrl+V. */
export const PASTE_EVENT_GRACE_MS = 150;
/** The server's devicectl copy + readback can take a few seconds. */
const PASTE_REQUEST_TIMEOUT_MS = 25_000;

type ShortcutState = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** Cmd+V (or Ctrl+V): left to the browser so it fires a `paste` event. */
export function isPasteShortcut(e: ShortcutState): boolean {
  return e.code === "KeyV" && e.metaKey !== e.ctrlKey && !e.altKey && !e.shiftKey;
}

export { PASTE_KEY_EVENTS };

export type PasteStageOutcome =
  | { ok: true; bytes: number }
  | { ok: false; error: string };

/** Stage `text` on the guest pasteboard; ok only when the server verified it. */
export async function stageGuestPasteboard(
  endpoint: string,
  text: string,
  { fetchImpl = fetch, timeoutMs = PASTE_REQUEST_TIMEOUT_MS }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PasteStageOutcome> {
  if (new TextEncoder().encode(text).length > PASTEBOARD_TEXT_LIMIT_BYTES) {
    return { ok: false, error: `text is over ${PASTEBOARD_TEXT_LIMIT_BYTES / 1024} KiB` };
  }
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "request failed" };
  }
  let body: { ok?: unknown; verified?: unknown; bytes?: unknown; error?: unknown } | null = null;
  try {
    body = await res.json();
  } catch {}
  if (res.ok && body?.ok === true && body.verified === true && typeof body.bytes === "number") {
    return { ok: true, bytes: body.bytes };
  }
  return { ok: false, error: typeof body?.error === "string" ? body.error : `HTTP ${res.status}` };
}
