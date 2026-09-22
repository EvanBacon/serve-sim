import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Panel } from "../client/Panel";

const FLOATING_CHROME = [
  "top-3",
  "bottom-3",
  "rounded-[14px]",
  "border border-white/10",
  "shadow-[0_12px_40px_rgba(0,0,0,0.55)]",
];

describe("Panel", () => {
  test("left sidebar floats with the same chrome as the right sidebar", () => {
    const left = renderToStaticMarkup(
      <Panel open width={320} side="left">
        Sidebar
      </Panel>,
    );
    const right = renderToStaticMarkup(
      <Panel open width={320} side="right">
        Tools
      </Panel>,
    );

    for (const token of FLOATING_CHROME) {
      expect(left).toContain(token);
      expect(right).toContain(token);
    }
    expect(left).toContain("left-3");
    expect(right).toContain("right-3");
    expect(left).not.toContain("left-0");
    expect(left).not.toContain("rounded-none");
    expect(left).not.toContain("border-r");
    expect(left).not.toContain("top-0");
    expect(left).not.toContain("bottom-0");
  });

  test("closed floating sidebars slide fully off screen past their inset", () => {
    const left = renderToStaticMarkup(
      <Panel open={false} width={320} side="left">
        Sidebar
      </Panel>,
    );
    const right = renderToStaticMarkup(
      <Panel open={false} width={320} side="right">
        Tools
      </Panel>,
    );

    expect(left).toContain("translateX(calc(-100% - 24px))");
    expect(right).toContain("translateX(calc(100% + 24px))");
  });
});
