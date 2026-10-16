import { homedir } from "node:os";

/**
 * Replace the user's home directory with `~` everywhere in a diagnostics
 * value (strings, arrays, plain objects). Diagnostics are meant to be pasted
 * into bug reports; usernames in paths are the common leak. Matches unless
 * the next characters would continue the final path component's name.
 */
export function redactHome<T>(value: T, home: string = homedir()): T {
  if (!home || home === "/") return value;
  // Only whole path components: `/Users/bob` must not turn `/Users/bobby`,
  // `/Users/bob-2`, or `/Users/bob.old` into `~by` etc., but a trailing
  // newline, quote, colon, or sentence-ending period still ends the home.
  const escaped = home.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9_-])`, "g");
  const visit = (input: unknown): unknown => {
    if (typeof input === "string") return input.replace(pattern, "~");
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, entry]) => [key, visit(entry)]));
    }
    return input;
  };
  return visit(value) as T;
}
