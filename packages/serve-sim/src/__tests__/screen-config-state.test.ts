import { describe, expect, test } from "bun:test";
import { resolveScreenConfigUpdate } from "../client/simulator/screen-config-state";

describe("screen config state", () => {
  test("adopts parent-provided config without echoing it back", () => {
    const update = resolveScreenConfigUpdate(
      null,
      { width: 1179, height: 2556, orientation: "portrait" },
      "external",
    );

    expect(update).toEqual({
      config: { width: 1179, height: 2556, orientation: "portrait" },
      notifyParent: false,
    });
  });

  test("notifies for sizes reported by the stream itself", () => {
    const update = resolveScreenConfigUpdate(
      null,
      { width: 1179, height: 2556, orientation: "portrait" },
      "reported",
    );

    expect(update?.notifyParent).toBe(true);
  });

  test("keeps prior orientation when image dimensions do not include one", () => {
    const update = resolveScreenConfigUpdate(
      { width: 2868, height: 1320, orientation: "landscape_left" },
      { width: 1320, height: 2868 },
      "reported",
    );

    expect(update).toEqual({
      config: { width: 1320, height: 2868, orientation: "landscape_left" },
      notifyParent: true,
    });
  });

  test("skips identical configs", () => {
    expect(
      resolveScreenConfigUpdate(
        { width: 1179, height: 2556, orientation: "portrait" },
        { width: 1179, height: 2556, orientation: "portrait" },
        "reported",
      ),
    ).toBeNull();
  });
});
