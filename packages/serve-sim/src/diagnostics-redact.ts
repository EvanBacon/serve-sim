import { homedir } from "node:os";

/**
 * Replace the user's home directory with `~` everywhere in a diagnostics
 * value (strings, arrays, plain objects). Diagnostics are meant to be pasted
 * into bug reports; usernames in paths are the common leak.
 */
export function redactHome<T>(value: T, home: string = homedir()): T {
  if (!home || home === "/") return value;
  const visit = (input: unknown): unknown => {
    if (typeof input === "string") return input.split(home).join("~");
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, entry]) => [key, visit(entry)]));
    }
    return input;
  };
  return visit(value) as T;
}
