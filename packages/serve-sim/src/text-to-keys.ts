// Convert a US-keyboard text string into a sequence of USB HID Usage Page 0x07
// keyboard events (`down`/`up`) suitable for the serve-sim WS key opcode (0x06).
//
// Mirrors the AXe `type` command's character coverage: A-Z, a-z, 0-9, space,
// newline, tab, and the standard ASCII punctuation reachable on a US layout.

const LEFT_SHIFT = 0xe1;

// Char → { usage, shift } for US keyboard physical keys.
type KeySpec = { usage: number; shift: boolean };

function buildMap(): Record<string, KeySpec> {
  const map: Record<string, KeySpec> = {};

  for (let i = 0; i < 26; i++) {
    const usage = 0x04 + i;
    map[String.fromCharCode(0x61 + i)] = { usage, shift: false }; // a-z
    map[String.fromCharCode(0x41 + i)] = { usage, shift: true };  // A-Z
  }

  // Digits row: 1..9 then 0
  const digits = "1234567890";
  const digitShifted = "!@#$%^&*()";
  for (let i = 0; i < 10; i++) {
    const usage = 0x1e + i;
    map[digits[i]!] = { usage, shift: false };
    map[digitShifted[i]!] = { usage, shift: true };
  }

  const rest: Array<[string, string, number]> = [
    // [plain, shifted, usage]
    ["-", "_", 0x2d],
    ["=", "+", 0x2e],
    ["[", "{", 0x2f],
    ["]", "}", 0x30],
    ["\\", "|", 0x31],
    [";", ":", 0x33],
    ["'", '"', 0x34],
    ["`", "~", 0x35],
    [",", "<", 0x36],
    [".", ">", 0x37],
    ["/", "?", 0x38],
  ];
  for (const [plain, shifted, usage] of rest) {
    map[plain] = { usage, shift: false };
    map[shifted] = { usage, shift: true };
  }

  map[" "] = { usage: 0x2c, shift: false };
  map["\n"] = { usage: 0x28, shift: false }; // Enter
  map["\t"] = { usage: 0x2b, shift: false }; // Tab

  return map;
}

export const US_KEYBOARD_MAP: Readonly<Record<string, KeySpec>> = buildMap();

export type KeyEvent = { type: "down" | "up"; usage: number };

export class UnsupportedCharacterError extends Error {
  constructor(public readonly char: string) {
    super(`Unsupported character: ${JSON.stringify(char)}`);
  }
}

/** Send a sequence of key events to a serve-sim WS endpoint using the 0x06
 *  (WS_MSG_KEY) opcode. Each event is sent as one binary frame. */
export async function sendKeyEventsToWs(
  wsUrl: string,
  events: ReadonlyArray<KeyEvent>,
  // iOS coalesces events that arrive in the same tick, so a small gap keeps
  // long strings reliable without making the command noticeably slow.
  perEventDelayMs = 4,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onopen = async () => {
      try {
        for (const ev of events) {
          const json = new TextEncoder().encode(JSON.stringify(ev));
          const msg = new Uint8Array(1 + json.length);
          msg[0] = 0x06; // WS_MSG_KEY
          msg.set(json, 1);
          ws.send(msg);
          if (perEventDelayMs > 0) {
            await new Promise((r) => setTimeout(r, perEventDelayMs));
          }
        }
        setTimeout(() => { ws.close(); resolve(); }, 50);
      } catch (err) {
        ws.close();
        reject(err);
      }
    };

    ws.onerror = () => {
      reject(new Error(`WebSocket connection failed: ${wsUrl}`));
    };
  });
}

/** Returns the events needed to type `text`, or throws on unsupported chars.
 *  Each character emits (optional shift down) → key down → key up → (optional shift up). */
export function textToKeyEvents(text: string): KeyEvent[] {
  const events: KeyEvent[] = [];
  for (const ch of text) {
    // Normalize CRLF / lone CR to a single Enter press.
    if (ch === "\r") continue;
    const spec = US_KEYBOARD_MAP[ch];
    if (!spec) throw new UnsupportedCharacterError(ch);
    if (spec.shift) events.push({ type: "down", usage: LEFT_SHIFT });
    events.push({ type: "down", usage: spec.usage });
    events.push({ type: "up", usage: spec.usage });
    if (spec.shift) events.push({ type: "up", usage: LEFT_SHIFT });
  }
  return events;
}
