import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamStatusPill } from "../client/components/stream-status-pill";

describe("StreamStatusPill", () => {
  test("renders live state", () => {
    const html = renderToStaticMarkup(<StreamStatusPill streaming />);

    expect(html).toContain('data-testid="stream-status-pill"');
    expect(html).toContain(">live</span>");
    expect(html).not.toContain("connecting");
  });

  test("renders connecting state", () => {
    const html = renderToStaticMarkup(<StreamStatusPill streaming={false} />);

    expect(html).toContain("connecting");
    expect(html).not.toContain(">live</span>");
  });
});
