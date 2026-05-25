import { describe, expect, test } from "bun:test";
import { preserveStreamOrientation } from "../client/hooks/use-h264-stream";

describe("preserveStreamOrientation", () => {
  test("keeps the last known orientation when decoded frames only report dimensions", () => {
    expect(
      preserveStreamOrientation(
        { width: 1080, height: 2400, orientation: "landscape_left" },
        { width: 1080, height: 2400 },
      ),
    ).toEqual({ width: 1080, height: 2400, orientation: "landscape_left" });
  });

  test("allows explicit orientation updates from the device config endpoint", () => {
    expect(
      preserveStreamOrientation(
        { width: 1080, height: 2400, orientation: "landscape_left" },
        { width: 1080, height: 2400, orientation: "portrait" },
      ),
    ).toEqual({ width: 1080, height: 2400, orientation: "portrait" });
  });
});
