import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SimulatorToolbar } from "../simulator/SimulatorToolbar";

const exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });

describe("SimulatorToolbar.Title", () => {
  test("can hide the runtime subtitle", () => {
    const html = renderToStaticMarkup(
      <SimulatorToolbar
        exec={exec}
        deviceUdid="booted"
        deviceName="iPhone 16 (26.5)"
        deviceRuntime="iOS-26-5"
        streaming
      >
        <SimulatorToolbar.Title hideSubtitle />
      </SimulatorToolbar>,
    );

    expect(html).toContain("iPhone 16 (26.5)");
    expect(html).not.toContain("iOS-26-5");
  });
});
