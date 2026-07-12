import { describe, expect, test } from "bun:test";
import {
  CONTENT_SIZE_CATEGORIES,
  UI_OPTIONS,
  normalizeUiValue,
  parseUiArgs,
} from "../ui-settings";

describe("parseUiArgs", () => {
  test("no args requests status", () => {
    expect(parseUiArgs([])).toEqual({ command: "status", json: false });
  });

  test("status with --json and -d", () => {
    expect(parseUiArgs(["status", "--json", "-d", "ABC"])).toEqual({
      command: "status",
      json: true,
      device: "ABC",
    });
  });

  test("get a single option", () => {
    expect(parseUiArgs(["appearance"])).toEqual({
      command: "get",
      option: "appearance",
      json: false,
    });
  });

  test("set an option with a value", () => {
    expect(parseUiArgs(["appearance", "dark", "-d", "ABC"])).toEqual({
      command: "set",
      option: "appearance",
      value: "dark",
      device: "ABC",
      json: false,
    });
  });

  test("unknown option is an error", () => {
    expect(parseUiArgs(["sound", "50"]).error).toMatch(/unknown option/i);
  });

  test("dangling -d/--device flag is an error", () => {
    expect(parseUiArgs(["appearance", "-d"]).error).toMatch(/requires a value/i);
    expect(parseUiArgs(["status", "--device"]).error).toMatch(/requires a value/i);
  });

  test("invalid value is an error", () => {
    expect(parseUiArgs(["appearance", "blue"]).error).toMatch(/invalid value/i);
  });

  test("color filter accepts vision-deficiency aliases", () => {
    expect(parseUiArgs(["color-filter", "protanopia"]).value).toBe("red-green");
    expect(parseUiArgs(["color-filter", "deuteranopia"]).value).toBe("green-red");
    expect(parseUiArgs(["color-filter", "tritanopia"]).value).toBe("blue-yellow");
    expect(parseUiArgs(["color-filter", "grayscale"]).value).toBe("grayscale");
  });

  test("text-size accepts categories and increment/decrement", () => {
    expect(parseUiArgs(["text-size", "large"]).value).toBe("large");
    expect(parseUiArgs(["text-size", "accessibility-medium"]).value).toBe(
      "accessibility-medium",
    );
    expect(parseUiArgs(["text-size", "increment"]).value).toBe("increment");
    expect(parseUiArgs(["text-size", "giant"]).error).toMatch(/invalid value/i);
  });
});

describe("normalizeUiValue", () => {
  test("toggles accept on/off synonyms", () => {
    for (const v of ["on", "true", "enabled", "1", "yes"]) {
      expect(normalizeUiValue("reduce-motion", v)).toBe("on");
    }
    for (const v of ["off", "false", "disabled", "0", "no"]) {
      expect(normalizeUiValue("reduce-motion", v)).toBe("off");
    }
  });

  test("non-toggle options pass through canonical values only", () => {
    expect(normalizeUiValue("liquid-glass", "tinted")).toBe("tinted");
    expect(normalizeUiValue("liquid-glass", "frosted")).toBeNull();
  });
});

describe("option catalogue", () => {
  test("covers every sidebar option", () => {
    expect(Object.keys(UI_OPTIONS).sort()).toEqual(
      [
        "appearance",
        "color-filter",
        "increase-contrast",
        "liquid-glass",
        "reduce-motion",
        "reduce-transparency",
        "show-borders",
        "text-size",
        "voiceover",
      ].sort(),
    );
  });

  test("content size categories span standard and accessibility ranges", () => {
    expect(CONTENT_SIZE_CATEGORIES).toHaveLength(12);
    expect(CONTENT_SIZE_CATEGORIES[0]).toBe("extra-small");
    expect(CONTENT_SIZE_CATEGORIES[3]).toBe("large");
    expect(CONTENT_SIZE_CATEGORIES[11]).toBe(
      "accessibility-extra-extra-extra-large",
    );
  });
});
