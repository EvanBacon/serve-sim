import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CollapsibleSection } from "../client/components/collapsible-section";

const noop = () => {};

describe("CollapsibleSection", () => {
  test("uses surface contrast without an outline border", () => {
    const html = renderToStaticMarkup(
      <CollapsibleSection open onOpenChange={noop} summary="Simulator">
        Body
      </CollapsibleSection>,
    );

    expect(html).toContain("lem-section bg-panel rounded-[10px]");
    expect(html).not.toContain("border-white/8");
  });
});
