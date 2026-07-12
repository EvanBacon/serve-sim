import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const globalCss = readFileSync(join(import.meta.dir, "../client/global.css"), "utf8");

describe("global CSS panel variables", () => {
  test("shares the sidebar backing color through a root CSS variable", () => {
    expect(globalCss).toContain("--serve-sim-panel-bg: #181818;");
    expect(globalCss).toContain("--color-panel-bg: var(--serve-sim-panel-bg);");
  });
});
