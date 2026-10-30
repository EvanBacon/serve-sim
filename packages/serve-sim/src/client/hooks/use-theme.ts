import { useSyncExternalStore } from "react";
import {
  DARK_SCHEME_QUERY,
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  persistThemePreference,
  readThemePreference,
  resolveTheme,
  systemPrefersDark,
  type ResolvedTheme,
  type ThemePreference,
} from "../utils/theme";

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

export interface ThemeStore {
  getSnapshot(): ThemeState;
  subscribe(listener: () => void): () => void;
  setPreference(preference: ThemePreference): void;
}

const SERVER_STATE: ThemeState = { preference: "system", resolved: "dark" };

function safeStorage(win: Window): Storage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

// Owns the preference for one window: persists choices, re-resolves when the
// OS appearance flips (while on "system"), follows other tabs via the storage
// event, and keeps data-theme on <html> in sync.
export function createThemeStore(win: Window): ThemeStore {
  const storage = safeStorage(win);
  let preference = readThemePreference(storage);
  let systemDark = systemPrefersDark(win);
  let state: ThemeState = { preference, resolved: resolveTheme(preference, systemDark) };
  const listeners = new Set<() => void>();
  let detach: (() => void) | null = null;

  const update = () => {
    const resolved = resolveTheme(preference, systemDark);
    applyResolvedTheme(win.document.documentElement, resolved);
    if (state.preference === preference && state.resolved === resolved) return;
    state = { preference, resolved };
    for (const listener of listeners) listener();
  };

  const attach = () => {
    const media = typeof win.matchMedia === "function" ? win.matchMedia(DARK_SCHEME_QUERY) : null;
    const onMediaChange = (event: MediaQueryListEvent) => {
      systemDark = event.matches;
      update();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      preference = readThemePreference(storage);
      update();
    };
    media?.addEventListener?.("change", onMediaChange);
    win.addEventListener("storage", onStorage);
    // Catch up on anything that changed while nobody was listening.
    systemDark = media ? media.matches : systemDark;
    preference = readThemePreference(storage);
    update();
    return () => {
      media?.removeEventListener?.("change", onMediaChange);
      win.removeEventListener("storage", onStorage);
    };
  };

  // Correct any drift from the <head> boot script (e.g. a cached page).
  applyResolvedTheme(win.document.documentElement, state.resolved);

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (!detach) detach = attach();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && detach) {
          detach();
          detach = null;
        }
      };
    },
    setPreference(next) {
      preference = next;
      persistThemePreference(storage, next);
      update();
    },
  };
}

let defaultStore: ThemeStore | null = null;
function getDefaultStore(): ThemeStore | null {
  if (typeof window === "undefined") return null;
  return (defaultStore ??= createThemeStore(window));
}

const noopSubscribe = () => () => {};

export function useTheme(store: ThemeStore | null = getDefaultStore()) {
  const state = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : () => SERVER_STATE,
    () => SERVER_STATE,
  );
  return {
    ...state,
    setPreference: store ? store.setPreference : () => {},
  };
}
