import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Panel } from "../client/Panel";

describe("Panel", () => {
  test("left sidebar mirrors the floating panel chrome on the opposite edge", () => {
    const html = renderToStaticMarkup(
      <Panel open width={320} side="left">
        Sidebar
      </Panel>,
    );

    expect(html).toContain("top-3");
    expect(html).toContain("bottom-3");
    expect(html).toContain("left-3");
    expect(html).toContain("rounded-[14px]");
    expect(html).toContain("border border-white/10");
    expect(html).toContain("shadow-[0_12px_40px_rgba(0,0,0,0.55)]");
  });

  test("closed left sidebar slides fully past the inset gutter", () => {
    const html = renderToStaticMarkup(
      <Panel open={false} width={320} side="left">
        Sidebar
      </Panel>,
    );

    expect(html).toContain("transform:translateX(calc(-100% - 24px))");
  });
});
