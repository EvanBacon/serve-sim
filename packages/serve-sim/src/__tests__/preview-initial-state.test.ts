import { describe, expect, test } from "bun:test";
import {
  parsePreviewPanes,
  parseSimulatorTheme,
  selectInitialRightPane,
} from "../preview-initial-state";

describe("parsePreviewPanes", () => {
  test("normalizes, de-duplicates, and preserves supported panes", () => {
    expect(parsePreviewPanes(" tools,DEVTOOLS,tools ")).toEqual(["tools", "devtools"]);
  });

  test("allows none as the exclusive empty layout", () => {
    expect(parsePreviewPanes("none")).toEqual([]);
  });

  test("rejects unknown and ambiguous pane lists", () => {
    expect(() => parsePreviewPanes("tools,inspector")).toThrow("Unknown pane: inspector");
    expect(() => parsePreviewPanes("none,tools")).toThrow("Expected 'none'");
  });
});

describe("parseSimulatorTheme", () => {
  test("accepts light and dark regardless of case", () => {
    expect(parseSimulatorTheme("LIGHT")).toBe("light");
    expect(parseSimulatorTheme("dark")).toBe("dark");
  });

  test("rejects unsupported themes", () => {
    expect(() => parseSimulatorTheme("system")).toThrow("Expected simulator theme");
  });
});

describe("selectInitialRightPane", () => {
  test("gives DevTools precedence when both right-side panes are requested", () => {
    expect(selectInitialRightPane(["tools", "devtools"])).toBe("devtools");
  });
});
