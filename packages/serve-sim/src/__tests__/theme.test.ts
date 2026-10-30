import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import {
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  parseThemePreference,
  persistThemePreference,
  readThemePreference,
  resolveTheme,
  themeBootScript,
  type ThemePreference,
} from "../client/utils/theme";
import { createThemeStore } from "../client/hooks/use-theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("parseThemePreference", () => {
  test("accepts the three known preferences", () => {
    for (const pref of THEME_PREFERENCES) expect(parseThemePreference(pref)).toBe(pref);
  });

  test("falls back to system for missing or unknown values", () => {
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference(undefined)).toBe("system");
    expect(parseThemePreference("")).toBe("system");
    expect(parseThemePreference("Dark")).toBe("system");
    expect(parseThemePreference("sepia")).toBe("system");
  });
});

describe("resolveTheme", () => {
  test("explicit preferences ignore the OS appearance", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("system follows prefers-color-scheme", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("theme persistence", () => {
  test("reads a stored preference", () => {
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "light" }))).toBe("light");
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "dark" }))).toBe("dark");
  });

  test("defaults to system when nothing (or junk) is stored", () => {
    expect(readThemePreference(memoryStorage())).toBe("system");
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "neon" }))).toBe("system");
    expect(readThemePreference(null)).toBe("system");
  });

  test("tolerates storage that throws (privacy mode, sandboxed iframes)", () => {
    expect(readThemePreference(throwingStorage)).toBe("system");
    expect(() => persistThemePreference(throwingStorage, "dark")).not.toThrow();
  });

  test("stores explicit choices and clears the key for system", () => {
    const storage = memoryStorage();
    persistThemePreference(storage, "light");
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("light");
    persistThemePreference(storage, "dark");
    expect(readThemePreference(storage)).toBe("dark");
    persistThemePreference(storage, "system");
    expect(storage.data.has(THEME_STORAGE_KEY)).toBe(false);
    expect(readThemePreference(storage)).toBe("system");
  });
});

describe("applyResolvedTheme", () => {
  test("sets data-theme on the root element", () => {
    const window = new Window();
    const root = window.document.documentElement as unknown as HTMLElement;
    applyResolvedTheme(root, "light");
    expect(root.getAttribute("data-theme")).toBe("light");
    applyResolvedTheme(root, "dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
  });
});

describe("themeBootScript", () => {
  // Run the inline <head> script in a fresh window and report what it set.
  function runBootScript({
    stored,
    systemDark,
    matchMedia = true,
    storageThrows = false,
  }: {
    stored?: string;
    systemDark: boolean;
    matchMedia?: boolean;
    storageThrows?: boolean;
  }): string | null {
    const window = new Window();
    const storage = storageThrows ? throwingStorage : memoryStorage(stored ? { [THEME_STORAGE_KEY]: stored } : {});
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        if (storageThrows) throw new Error("SecurityError");
        return storage;
      },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMedia
        ? (query: string) => ({ matches: query === "(prefers-color-scheme: dark)" ? systemDark : !systemDark })
        : undefined,
    });
    new Function("window", "document", themeBootScript())(
      window,
      window.document,
    );
    return window.document.documentElement.getAttribute("data-theme");
  }

  test("matches resolveTheme for every preference and OS appearance", () => {
    const cases: Array<ThemePreference | undefined> = [undefined, ...THEME_PREFERENCES];
    for (const stored of cases) {
      for (const systemDark of [true, false]) {
        expect(runBootScript({ stored, systemDark })).toBe(
          resolveTheme(parseThemePreference(stored ?? null), systemDark),
        );
      }
    }
  });

  test("ignores garbage stored values", () => {
    expect(runBootScript({ stored: "neon", systemDark: false })).toBe("light");
    expect(runBootScript({ stored: "neon", systemDark: true })).toBe("dark");
  });

  test("still applies a theme when storage or matchMedia are unavailable", () => {
    expect(runBootScript({ systemDark: false, storageThrows: true })).toBe("light");
    // No matchMedia: keep the historical dark UI.
    expect(runBootScript({ stored: undefined, systemDark: false, matchMedia: false })).toBe("dark");
    expect(runBootScript({ stored: "light", systemDark: true, matchMedia: false })).toBe("light");
  });

  test("is a self-contained script safe to inline in <head>", () => {
    const script = themeBootScript();
    expect(script).not.toContain("</script");
    expect(script).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });
});

describe("preview HTML shells", () => {
  // Both the shipped preview page and the dev server must set the theme in
  // <head>, before the stylesheet, so the first paint uses the right palette.
  for (const file of ["../../build.ts", "../../dev.ts"]) {
    test(`${file.replace("../../", "")} inlines the theme boot script before the CSS`, () => {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      const bootIndex = source.indexOf("${themeBootScript()}");
      const cssIndex = source.indexOf("<style>${tailwindCss}</style>");
      expect(bootIndex).toBeGreaterThan(-1);
      expect(cssIndex).toBeGreaterThan(-1);
      expect(bootIndex).toBeLessThan(cssIndex);
    });
  }
});

describe("createThemeStore", () => {
  function fakeWindow({ stored, systemDark }: { stored?: string; systemDark: boolean }) {
    const window = new Window();
    const storage = memoryStorage(stored ? { [THEME_STORAGE_KEY]: stored } : {});
    const mediaListeners = new Set<(event: { matches: boolean }) => void>();
    const media = {
      matches: systemDark,
      addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => mediaListeners.add(fn),
      removeEventListener: (_: string, fn: (event: { matches: boolean }) => void) => mediaListeners.delete(fn),
    };
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => media });
    const setSystemDark = (matches: boolean) => {
      media.matches = matches;
      for (const fn of mediaListeners) fn({ matches });
    };
    return { window: window as unknown as globalThis.Window, storage, setSystemDark, mediaListeners };
  }

  const themeAttr = (win: globalThis.Window) => win.document.documentElement.getAttribute("data-theme");

  test("starts from the stored preference and applies it to <html>", () => {
    const { window } = fakeWindow({ stored: "light", systemDark: true });
    const store = createThemeStore(window);
    expect(store.getSnapshot()).toEqual({ preference: "light", resolved: "light" });
    expect(themeAttr(window)).toBe("light");
  });

  test("setPreference persists, re-resolves and notifies subscribers", () => {
    const { window, storage } = fakeWindow({ systemDark: true });
    const store = createThemeStore(window);
    let notified = 0;
    store.subscribe(() => notified++);

    store.setPreference("light");
    expect(store.getSnapshot()).toEqual({ preference: "light", resolved: "light" });
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("light");
    expect(themeAttr(window)).toBe("light");

    store.setPreference("system");
    expect(store.getSnapshot()).toEqual({ preference: "system", resolved: "dark" });
    expect(storage.data.has(THEME_STORAGE_KEY)).toBe(false);
    expect(themeAttr(window)).toBe("dark");
    expect(notified).toBe(2);
  });

  test("follows OS appearance changes only while on system", () => {
    const { window, setSystemDark } = fakeWindow({ systemDark: false });
    const store = createThemeStore(window);
    store.subscribe(() => {});
    expect(store.getSnapshot().resolved).toBe("light");

    setSystemDark(true);
    expect(store.getSnapshot().resolved).toBe("dark");
    expect(themeAttr(window)).toBe("dark");

    store.setPreference("light");
    setSystemDark(false);
    setSystemDark(true);
    expect(store.getSnapshot().resolved).toBe("light");
  });

  test("picks up a preference changed in another tab", () => {
    const { window, storage } = fakeWindow({ systemDark: true });
    const store = createThemeStore(window);
    store.subscribe(() => {});
    storage.data.set(THEME_STORAGE_KEY, "light");
    window.dispatchEvent(new (window as any).StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(store.getSnapshot()).toEqual({ preference: "light", resolved: "light" });
    expect(themeAttr(window)).toBe("light");
  });

  test("detaches OS listeners when the last subscriber leaves", () => {
    const { window, mediaListeners } = fakeWindow({ systemDark: true });
    const store = createThemeStore(window);
    const a = store.subscribe(() => {});
    const b = store.subscribe(() => {});
    expect(mediaListeners.size).toBe(1);
    a();
    expect(mediaListeners.size).toBe(1);
    b();
    expect(mediaListeners.size).toBe(0);
  });
});
