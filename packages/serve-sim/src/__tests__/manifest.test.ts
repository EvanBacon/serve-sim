import { describe, expect, test } from "bun:test";
import { parseSessionManifest } from "../manifest";

describe("parseSessionManifest", () => {
  test("normalizes app paths relative to the manifest directory", () => {
    const manifest = parseSessionManifest(JSON.stringify({
      session: "ship-sprint",
      apps: [{
        label: "Example",
        device: "iPhone 16 Pro",
        appPath: "build/Example.app",
        bundleId: "com.example.app",
        displayName: "Example",
      }],
    }), "/tmp/project");

    expect(manifest.session).toBe("ship-sprint");
    expect(manifest.apps[0]).toEqual({
      label: "Example",
      device: "iPhone 16 Pro",
      appPath: "/tmp/project/build/Example.app",
      bundleId: "com.example.app",
      displayName: "Example",
    });
  });

  test("requires a non-empty apps array", () => {
    expect(() => parseSessionManifest(JSON.stringify({ apps: [] }))).toThrow(
      "manifest must contain a non-empty apps array",
    );
  });

  test("requires install and identity fields for every app", () => {
    expect(() => parseSessionManifest(JSON.stringify({
      apps: [{ device: "iPhone 16 Pro", appPath: "App.app" }],
    }))).toThrow("manifest apps[0].bundleId must be a non-empty string");
  });
});
