import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SIM_ACTIONS_BUTTONS_STYLE,
  SIM_ACTIONS_PILL_STYLE,
  SIM_ACTIONS_ROW_CLASS,
} from "../client/utils/simulator-actions-layout";

const clientDir = join(import.meta.dir, "../client");
const clientTsx = readFileSync(join(clientDir, "client.tsx"), "utf8");
const globalCss = readFileSync(join(clientDir, "global.css"), "utf8");

describe("simulator actions toolbar layout", () => {
  test("the row is not capped at the device column, only at the viewport", () => {
    const classes = SIM_ACTIONS_ROW_CLASS.split(/\s+/);
    // `max-w-full` capped the row at the device width, squeezing the pill
    // below its buttons so the reload/frame icons spilled past its edges.
    expect(classes).not.toContain("max-w-full");
    expect(classes).toContain("w-max");
    expect(classes).toContain("shrink-0");
    expect(classes.some((c) => c.startsWith("max-w-[calc(100vw"))).toBe(true);
    expect(clientTsx).toContain("SIM_ACTIONS_ROW_CLASS");
  });

  test("buttons wrap inside the pill instead of overflowing it on tiny viewports", () => {
    expect(SIM_ACTIONS_PILL_STYLE.maxWidth).toBe("100%");
    expect(SIM_ACTIONS_PILL_STYLE.minWidth).toBe(0);
    expect(SIM_ACTIONS_BUTTONS_STYLE.flexWrap).toBe("wrap");
    expect(SIM_ACTIONS_BUTTONS_STYLE.flexShrink).toBe(1);
    expect(SIM_ACTIONS_BUTTONS_STYLE.minWidth).toBe(0);
  });

  test("the inspect button never shrinks out of round", () => {
    const ax = clientTsx.slice(clientTsx.indexOf('aria-label="Accessibility overlay"'));
    expect(ax.slice(0, 200)).toContain("flexShrink: 0");
  });

  test("no scrub timeline in the toolbar", () => {
    expect(clientTsx).not.toMatch(/scrub-timeline|ScrubTimeline/);
  });
});

describe("resize corner arc", () => {
  test("is hidden at rest on hover-capable pointers and revealed by hovering the device", () => {
    expect(clientTsx).toContain("data-sim-frame");
    expect(globalCss).toContain(
      '[data-sim-frame]:not(:hover) [data-sim-resize-handle][data-resize-phase="idle"]:not(:focus-visible) > svg',
    );
    expect(globalCss).toMatch(/@media \(hover: hover\)\s*\{\s*\[data-sim-frame\]:not\(:hover\)/);
  });
});
