import { describe, expect, test } from "bun:test";
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
    expect(html).not.toContain("km total");
  });
});
