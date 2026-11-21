// Browser-safe pieces of the Linking tool, shared by the tools-panel widget
// and the `openUrl` / `linkingAction` host actions (host-rpc.ts).

export const MAX_URL_LENGTH = 2048;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Why `value` can't be handed to `simctl openurl`, or null when it can:
 * a string of at most 2048 chars, no control characters, with a scheme.
 */
export function urlProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return "Enter a URL";
  if (value.length > MAX_URL_LENGTH) return `URL is longer than ${MAX_URL_LENGTH} characters`;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return "URL contains control characters";
  }
  if (!SCHEME_RE.test(value)) return "URL needs a scheme, like myapp:// or https://";
  return null;
}

/**
 * Non-URL ways to open the app, run by the `linkingAction` host action.
 * `takesQuery` means text typed after the token is its argument.
 */
export const LINKING_ACTIONS = [
  { key: "spotlight", label: "Search", takesQuery: true },
  { key: "launch", label: "Launch", takesQuery: false },
  { key: "terminate", label: "Terminate", takesQuery: false },
  { key: "settings", label: "App Settings", takesQuery: false },
  { key: "notificationSettings", label: "Notification Settings", takesQuery: false },
] as const;

export type LinkingActionKey = (typeof LINKING_ACTIONS)[number]["key"];

export const LINKING_ACTION_KEYS: readonly LinkingActionKey[] = LINKING_ACTIONS.map((a) => a.key);

export function linkingActionLabel(key: LinkingActionKey): string {
  return LINKING_ACTIONS.find((a) => a.key === key)?.label ?? key;
}

/**
 * System UI that comes to the front while the widget's own tokens and
 * alerts run (Home, Spotlight — its own app on iOS 27 — Settings, wallpaper
 * and call UI, in-app Safari sheets, auth prompts). They're never the app
 * the widget acts on: it keeps targeting the last real app instead.
 */
const SYSTEM_SURFACES: ReadonlySet<string> = new Set([
  "com.apple.springboard",
  "com.apple.Spotlight",
  "com.apple.Preferences",
  "com.apple.PosterBoard",
  "com.apple.InCallService",
  "com.apple.SafariViewService",
  "com.apple.CoreAuthUI",
  "com.apple.AccessibilityUIServer",
  "com.apple.siri",
  "com.apple.SiriViewService",
  "com.apple.ScreenshotServicesService",
  "com.apple.WebSheet",
]);

/** Whether `bundleId` is system UI rather than an app the widget can target. */
export function isSystemSurface(bundleId: string | null | undefined): boolean {
  return typeof bundleId === "string" && SYSTEM_SURFACES.has(bundleId);
}

/**
 * The app the widget acts on: the foreground app, or — while a system
 * surface is in front, or detection has no answer — the last real app.
 * Null when no real app has been in front yet.
 */
export function linkingTarget(foreground: string | null, previous: string | null): string | null {
  if (foreground && !isSystemSurface(foreground)) return foreground;
  return previous && !isSystemSurface(previous) ? previous : null;
}

/** Tokens that act on the target app; disabled while there isn't one. */
export function actionNeedsApp(key: LinkingActionKey): boolean {
  return key !== "spotlight";
}

/** History key while no real app has been in front. */
export const SYSTEM_HISTORY_KEY = "(system)";

/** Longest Spotlight query the host action accepts. */
export const MAX_SPOTLIGHT_QUERY_LENGTH = 256;

// ─── History ───

export type LinkingInvocation =
  | { kind: "url"; url: string }
  | { kind: "action"; action: LinkingActionKey; query?: string };

export const LINKING_HISTORY_LIMIT = 6;
export const LINKING_HISTORY_STORAGE_KEY = "serve-sim:linking-history";

function sameInvocation(a: LinkingInvocation, b: LinkingInvocation): boolean {
  if (a.kind === "url") return b.kind === "url" && a.url === b.url;
  return b.kind === "action" && a.action === b.action && (a.query ?? "") === (b.query ?? "");
}

export type LinkingHistoryEvent =
  | { type: "add"; entry: LinkingInvocation }
  | { type: "clear" };

/** Newest first, de-duplicated (a rerun moves to the top), capped. */
export function linkingHistoryReducer(
  state: readonly LinkingInvocation[],
  event: LinkingHistoryEvent,
): LinkingInvocation[] {
  if (event.type === "clear") return [];
  const entry = normalizeInvocation(event.entry);
  if (!entry) return [...state];
  return [entry, ...state.filter((e) => !sameInvocation(e, entry))].slice(0, LINKING_HISTORY_LIMIT);
}

function normalizeInvocation(value: unknown): LinkingInvocation | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "url") return urlProblem(v.url) === null ? { kind: "url", url: v.url as string } : null;
  if (v.kind === "action" && (LINKING_ACTION_KEYS as readonly unknown[]).includes(v.action)) {
    const query = typeof v.query === "string" && v.query.trim() ? v.query.trim() : undefined;
    return query ? { kind: "action", action: v.action as LinkingActionKey, query } : { kind: "action", action: v.action as LinkingActionKey };
  }
  return null;
}

type HistoryStore = Record<string, LinkingInvocation[]>;

function readStore(storage: Pick<Storage, "getItem"> | null | undefined): HistoryStore {
  try {
    const raw = storage?.getItem(LINKING_HISTORY_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HistoryStore) : {};
  } catch {
    return {};
  }
}

/** The saved history for one app (keyed by bundle id), validated. */
export function readLinkingHistory(
  bundleId: string,
  storage: Pick<Storage, "getItem"> | null | undefined,
): LinkingInvocation[] {
  const list = readStore(storage)[bundleId];
  if (!Array.isArray(list)) return [];
  const out: LinkingInvocation[] = [];
  for (const item of list) {
    const entry = normalizeInvocation(item);
    if (entry && !out.some((e) => sameInvocation(e, entry))) out.push(entry);
  }
  return out.slice(0, LINKING_HISTORY_LIMIT);
}

/** Save one app's history; an empty list drops its key. */
export function writeLinkingHistory(
  bundleId: string,
  history: readonly LinkingInvocation[],
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
): void {
  try {
    const store = readStore(storage);
    if (history.length === 0) delete store[bundleId];
    else store[bundleId] = history.slice(0, LINKING_HISTORY_LIMIT);
    storage?.setItem(LINKING_HISTORY_STORAGE_KEY, JSON.stringify(store));
  } catch {}
}

/** One-line text for a history row. */
export function describeInvocation(entry: LinkingInvocation): string {
  if (entry.kind === "url") return entry.url;
  const label = linkingActionLabel(entry.action);
  return entry.query ? `${label} “${entry.query}”` : label;
}

// ─── Suggestions ───

/** `scheme://` and `https://domain/` completions matching `text`. */
export function linkingSuggestions(
  text: string,
  info: { schemes: readonly string[]; domains: readonly string[] } | null,
): string[] {
  if (!info) return [];
  const all = [
    ...info.schemes.map((s) => `${s}://`),
    ...info.domains.map((d) => `https://${d.replace(/^\*\./, "")}/`),
  ];
  const needle = text.trim().toLowerCase();
  return all.filter((s) => s.toLowerCase().startsWith(needle) && s.toLowerCase() !== needle);
}
