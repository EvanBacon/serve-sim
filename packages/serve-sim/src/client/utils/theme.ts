// Web UI appearance: a persisted "system" | "light" | "dark" preference,
// resolved against prefers-color-scheme and applied as data-theme on <html>.
// The palettes themselves live in global.css.

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "serve-sim:theme";
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

type ThemeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function readThemePreference(storage: Pick<ThemeStorage, "getItem"> | null | undefined): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** "system" is the default, so it clears the key rather than pinning it. */
export function persistThemePreference(storage: ThemeStorage | null | undefined, preference: ThemePreference): void {
  try {
    if (preference === "system") storage?.removeItem(THEME_STORAGE_KEY);
    else storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable (privacy mode, sandboxed iframe); the choice
    // still applies for this page load.
  }
}

/** Without matchMedia, keep the historical dark UI. */
export function systemPrefersDark(win: Pick<Window, "matchMedia"> | undefined): boolean {
  return typeof win?.matchMedia === "function" ? win.matchMedia(DARK_SCHEME_QUERY).matches : true;
}

export function applyResolvedTheme(root: HTMLElement, theme: ResolvedTheme): void {
  if (root.getAttribute("data-theme") !== theme) root.setAttribute("data-theme", theme);
}

// Inlined into <head> ahead of the stylesheet so the first paint already has
// the right palette (no dark flash for light-mode users). Must stay
// self-contained — it is serialized with Function#toString — and mirror
// readThemePreference + resolveTheme + systemPrefersDark above (theme.test.ts
// checks the two agree).
function applyThemeBeforePaint(storageKey: string, darkQuery: string) {
  var preference = null;
  try {
    preference = window.localStorage.getItem(storageKey);
  } catch {}
  var dark =
    preference === "dark" ||
    (preference !== "light" &&
      (typeof window.matchMedia !== "function" || window.matchMedia(darkQuery).matches));
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

export function themeBootScript(): string {
  const args = [THEME_STORAGE_KEY, DARK_SCHEME_QUERY].map((value) => JSON.stringify(value)).join(",");
  return `(${applyThemeBeforePaint.toString()})(${args});`.replace(/<\/script/gi, "<\\/script");
}

// Inline-style counterparts of the `bg-ink/N` and `text-ink-N` Tailwind
// utilities, for styles computed in JS (hover state, SVG attributes).
function percent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

/** Ink (white in dark mode, black in light mode) at `alpha` — fills, borders. */
export function inkFill(alpha: number): string {
  return `color-mix(in srgb, var(--serve-sim-ink, #fff) ${percent(alpha)}, transparent)`;
}

/** Ink text at `alpha`, with the same light-mode contrast boost as `text-ink-*`. */
export function inkText(alpha: number): string {
  return `color-mix(in srgb, var(--serve-sim-ink, #fff) calc(100% - ${percent(1 - alpha)} * var(--serve-sim-text-k, 1)), transparent)`;
}
