import { describe, expect, test } from "bun:test";
import {
  CHROME_VISIBILITY_STORAGE_KEY,
  parseChromeHiddenQuery,
  persistChromeHiddenPreference,
  readChromeHiddenPreference,
  shouldUseDeviceChrome,
  shouldWrapDeviceChrome,
} from "../client/utils/chrome-visibility";

describe("parseChromeHiddenQuery", () => {
  test("treats 0/off/false/hide/bare as hidden", () => {
    for (const value of ["0", "off", "false", "hide", "bare", "OFF", " False "]) {
      expect(parseChromeHiddenQuery(`chrome=${value}`)).toBe(true);
    }
  });

  test("treats 1/on/true/show as shown", () => {
    for (const value of ["1", "on", "true", "show", "ON"]) {
      expect(parseChromeHiddenQuery(`?chrome=${value}`)).toBe(false);
    }
  });

  test("ignores missing or unknown values", () => {
    expect(parseChromeHiddenQuery("")).toBeNull();
    expect(parseChromeHiddenQuery("device=abc")).toBeNull();
    expect(parseChromeHiddenQuery("chrome=")).toBeNull();
    expect(parseChromeHiddenQuery("chrome=maybe")).toBeNull();
    expect(parseChromeHiddenQuery(null)).toBeNull();
  });
});

describe("readChromeHiddenPreference", () => {
  test("defaults to shown when nothing is set", () => {
    expect(readChromeHiddenPreference()).toBe(false);
    expect(readChromeHiddenPreference({ search: "", storage: memoryStorage() })).toBe(false);
  });

  test("URL query wins over localStorage", () => {
    const storage = memoryStorage({ [CHROME_VISIBILITY_STORAGE_KEY]: "hidden" });
    expect(readChromeHiddenPreference({ search: "chrome=1", storage })).toBe(false);
    expect(readChromeHiddenPreference({ search: "chrome=0", storage: memoryStorage() })).toBe(true);
  });

  test("falls back to localStorage when the URL is silent", () => {
    expect(
      readChromeHiddenPreference({
        search: "device=abc",
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
  test("writes hidden/shown to storage and syncs ?chrome=0 on the URL", () => {
    const storage = memoryStorage();
    const urls: string[] = [];
    persistChromeHiddenPreference(true, {
      storage,
      location: { href: "http://localhost:3200/?device=abc" },
      replaceState: (url) => urls.push(url),
    });
    expect(storage.getItem(CHROME_VISIBILITY_STORAGE_KEY)).toBe("hidden");
    expect(urls).toEqual(["/?device=abc&chrome=0"]);

    persistChromeHiddenPreference(false, {
      storage,
      location: { href: "http://localhost:3200/?device=abc&chrome=0" },
      replaceState: (url) => urls.push(url),
    });
    expect(storage.getItem(CHROME_VISIBILITY_STORAGE_KEY)).toBe("shown");
    expect(urls[1]).toBe("/?device=abc");
  });

  test("skips replaceState when the query already matches", () => {
    const urls: string[] = [];
    persistChromeHiddenPreference(true, {
      location: { href: "http://localhost:3200/?chrome=0" },
      replaceState: (url) => urls.push(url),
    });
    expect(urls).toEqual([]);
  });
});

describe("shouldUseDeviceChrome", () => {
  test("shows chrome only when data exists, portrait, and the user has not hidden it", () => {
    expect(shouldUseDeviceChrome({ hasChrome: true, isLandscape: false, hideChrome: false })).toBe(true);
    expect(shouldUseDeviceChrome({ hasChrome: true, isLandscape: false, hideChrome: true })).toBe(false);
  });

  test("keeps landscape and missing-chrome paths unframed", () => {
    expect(shouldUseDeviceChrome({ hasChrome: true, isLandscape: true, hideChrome: false })).toBe(false);
    expect(shouldUseDeviceChrome({ hasChrome: true, isLandscape: true, hideChrome: true })).toBe(false);
    expect(shouldUseDeviceChrome({ hasChrome: false, isLandscape: false, hideChrome: false })).toBe(false);
  });

});

describe("shouldWrapDeviceChrome", () => {
  test("keeps the chrome wrapper mounted when the user hides the bezel", () => {
    expect(shouldWrapDeviceChrome({ hasChrome: true, isLandscape: false })).toBe(true);
    expect(shouldUseDeviceChrome({ hasChrome: true, isLandscape: false, hideChrome: true })).toBe(false);
  });

  test("does not wrap landscape or missing-chrome paths", () => {
    expect(shouldWrapDeviceChrome({ hasChrome: true, isLandscape: true })).toBe(false);
    expect(shouldWrapDeviceChrome({ hasChrome: false, isLandscape: false })).toBe(false);
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
