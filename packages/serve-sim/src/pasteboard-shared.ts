// Browser-safe constants for the pasteboard text bridge (#174); see pasteboard.ts.

/** Largest text `POST /pasteboard` accepts, in UTF-8 bytes. */
export const PASTEBOARD_TEXT_LIMIT_BYTES = 256 * 1024;

/** HID Left-GUI (Cmd) + V: paste the staged clipboard into the focused guest field. */
export const PASTE_KEY_EVENTS: ReadonlyArray<{ type: "down" | "up"; usage: number }> = [
  { type: "down", usage: 0xe3 },
  { type: "down", usage: 0x19 },
  { type: "up", usage: 0x19 },
  { type: "up", usage: 0xe3 },
];
