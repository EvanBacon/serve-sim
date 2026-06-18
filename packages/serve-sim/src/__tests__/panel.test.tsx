import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Panel } from "../client/Panel";

describe("Panel", () => {
  test("left sidebar is full height and only has a right border", () => {
    const html = renderToStaticMarkup(
      <Panel open width={320} side="left">
        Sidebar
      </Panel>,
    );

    expect(html).toContain("top-0");
    expect(html).toContain("bottom-0");
    expect(html).toContain("left-0");
    expect(html).toContain("rounded-none");
    expect(html).toContain("border-0");
    expect(html).toContain("border-r");
  });
});
