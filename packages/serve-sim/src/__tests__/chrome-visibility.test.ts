import { describe, expect, test } from "bun:test";
import {
  CHROME_VISIBILITY_STORAGE_KEY,
  persistChromeHiddenPreference,
  readChromeHiddenPreference,
  shouldUseDeviceChrome,
  shouldWrapDeviceChrome,
} from "../client/utils/chrome-visibility";

describe("readChromeHiddenPreference", () => {
  test("defaults to shown when nothing is set", () => {
    expect(readChromeHiddenPreference()).toBe(false);
    expect(readChromeHiddenPreference({ storage: memoryStorage() })).toBe(false);
  });

  test("reads only the current storage key, not a leftover ?chrome=0 or the v1 key", () => {
    // Stale URL / v1 storage must not keep the frame off.
    expect(
      readChromeHiddenPreference({
        storage: memoryStorage({ "serve-sim:chrome": "hidden" }),
      }),
    ).toBe(false);
    expect(
      readChromeHiddenPreference({
        storage: memoryStorage({ [CHROME_VISIBILITY_STORAGE_KEY]: "hidden" }),
      }),
    ).toBe(true);
    expect(
      readChromeHiddenPreference({
        storage: memoryStorage({ [CHROME_VISIBILITY_STORAGE_KEY]: "shown" }),
      }),
    ).toBe(false);
  });
});

describe("persistChromeHiddenPreference", () => {
  test("writes hidden/shown to storage and never adds ?chrome=0", () => {
    const storage = memoryStorage();
    const urls: string[] = [];
    persistChromeHiddenPreference(true, {
      storage,
      location: { href: "http://localhost:3200/?device=abc" },
      replaceState: (url) => urls.push(url),
    });
    expect(storage.getItem(CHROME_VISIBILITY_STORAGE_KEY)).toBe("hidden");
    expect(urls).toEqual([]);

    persistChromeHiddenPreference(false, {
      storage,
      location: { href: "http://localhost:3200/?device=abc&chrome=0" },
      replaceState: (url) => urls.push(url),
    });
    expect(storage.getItem(CHROME_VISIBILITY_STORAGE_KEY)).toBe("shown");
    expect(urls).toEqual(["/?device=abc"]);
  });

  test("strips a leftover ?chrome=0 even when the user is hiding the bezel", () => {
    const urls: string[] = [];
    persistChromeHiddenPreference(true, {
      location: { href: "http://localhost:3200/?device=abc&chrome=0" },
      replaceState: (url) => urls.push(url),
    });
    expect(urls).toEqual(["/?device=abc"]);
  });

  test("skips replaceState when the URL has no chrome param", () => {
    const urls: string[] = [];
    persistChromeHiddenPreference(true, {
      location: { href: "http://localhost:3200/?device=abc" },
      replaceState: (url) => urls.push(url),
    });
    expect(urls).toEqual([]);
  });
});

describe("shouldUseDeviceChrome", () => {
  test("shows chrome when data exists and the user has not hidden it", () => {
    expect(shouldUseDeviceChrome({ hasChrome: true, hideChrome: false })).toBe(true);
    expect(shouldUseDeviceChrome({ hasChrome: true, hideChrome: true })).toBe(false);
    expect(shouldUseDeviceChrome({ hasChrome: false, hideChrome: false })).toBe(false);
  });
});

describe("shouldWrapDeviceChrome", () => {
  test("keeps the chrome wrapper mounted when the user hides the bezel", () => {
    expect(shouldWrapDeviceChrome({ hasChrome: true })).toBe(true);
    expect(shouldUseDeviceChrome({ hasChrome: true, hideChrome: true })).toBe(false);
  });

  test("does not wrap devices without chrome data", () => {
    expect(shouldWrapDeviceChrome({ hasChrome: false })).toBe(false);
  });
});

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = { ...initial };
  return {
    get length() {
      return Object.keys(data).length;
    },
    clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key]! : null;
    },
    key(index: number) {
      return Object.keys(data)[index] ?? null;
    },
    removeItem(key: string) {
      delete data[key];
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
  };
}
