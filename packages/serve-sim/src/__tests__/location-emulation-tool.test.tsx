import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { LocationEmulationTool } from "../client/location-emulation-tool";

const exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });

describe("LocationEmulationTool", () => {
  test("hides distance status while collapsed and keeps responsive summary sizing", () => {
    const html = renderToStaticMarkup(
      <LocationEmulationTool udid="booted" exec={exec} />,
    );

    expect(html).toContain("Location");
    expect(html).toContain("[container-type:inline-size]");
    expect(html).not.toContain("<style>");
    expect(html).not.toContain("lem-location");
    expect(html).not.toContain("km total");
  });

  test("keeps location summary chevron anchored at compact widths", () => {
    const css = readFileSync(
      new URL("../client/global.css", import.meta.url),
      "utf8",
    );

    expect(css).toContain("[data-location-status-total]");
    expect(css).not.toContain("[data-location-status] {\n    grid-column: 1 / -1");
  });
});
