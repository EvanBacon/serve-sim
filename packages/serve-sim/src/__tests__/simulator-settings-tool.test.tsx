import { describe, expect, test } from "bun:test";
import {
  MAX_STANDARD_TEXT_SIZE_CATEGORY,
  STANDARD_TEXT_SIZE_CATEGORIES,
  TEXT_SIZE_CATEGORIES,
  isAccessibilityTextSize,
  isIosRuntime,
  textSizeAfterLargerAccessibilitySizesToggle,
  textSizeCategories,
  textSizeIndex,
} from "../client/components/simulator-settings-tool";

// The in-sim settings helper is an iOS-simulator Mach-O; spawning it inside a
// watchOS / tvOS / visionOS runtime aborts in dyld. The panel gates on the
// device runtime so non-iOS devices never trigger that spawn.
describe("isIosRuntime", () => {
  test("iOS runtimes are supported", () => {
    expect(isIosRuntime("iOS-26-5")).toBe(true);
    expect(isIosRuntime("iOS-18-0")).toBe(true);
  });

  test("non-iOS runtimes are unsupported", () => {
    expect(isIosRuntime("watchOS-11-2")).toBe(false);
    expect(isIosRuntime("tvOS-18-0")).toBe(false);
    expect(isIosRuntime("xrOS-2-0")).toBe(false);
    expect(isIosRuntime("visionOS-2-0")).toBe(false);
  });

  test("unknown/null runtime falls back to supported so the panel still renders", () => {
    expect(isIosRuntime(null)).toBe(true);
    expect(isIosRuntime("")).toBe(true);
  });
});

describe("text size controls", () => {
  test("default slider uses the standard iOS text-size range", () => {
    expect(textSizeCategories(false)).toEqual(STANDARD_TEXT_SIZE_CATEGORIES);
    expect(textSizeCategories(false)).toHaveLength(7);
  });

  test("larger accessibility sizes extend the slider range", () => {
    expect(textSizeCategories(true)).toEqual(TEXT_SIZE_CATEGORIES);
    expect(textSizeCategories(true)).toHaveLength(12);
    expect(textSizeCategories(true).at(-1)).toBe(
      "accessibility-extra-extra-extra-large",
    );
  });

  test("detects accessibility text-size categories", () => {
    expect(isAccessibilityTextSize("accessibility-medium")).toBe(true);
    expect(isAccessibilityTextSize("extra-extra-extra-large")).toBe(false);
    expect(isAccessibilityTextSize(undefined)).toBe(false);
  });

  test("maps slider index across standard and accessibility ranges", () => {
    expect(textSizeIndex("large", false)).toBe(3);
    expect(textSizeIndex("large", true)).toBe(3);
    expect(textSizeIndex("accessibility-medium", true)).toBe(7);
    expect(textSizeIndex("accessibility-extra-extra-extra-large", true)).toBe(11);
  });

  test("pins accessibility values to the standard maximum when larger sizes are off", () => {
    expect(textSizeIndex("accessibility-medium", false)).toBe(6);
    expect(textSizeIndex("accessibility-extra-extra-extra-large", false)).toBe(6);
  });

  test("turning larger accessibility sizes off falls back to the largest standard size", () => {
    expect(
      textSizeAfterLargerAccessibilitySizesToggle(
        "accessibility-extra-extra-extra-large",
        false,
      ),
    ).toBe(MAX_STANDARD_TEXT_SIZE_CATEGORY);
    expect(textSizeAfterLargerAccessibilitySizesToggle("large", false)).toBeNull();
    expect(
      textSizeAfterLargerAccessibilitySizesToggle("accessibility-medium", true),
    ).toBeNull();
  });
});
