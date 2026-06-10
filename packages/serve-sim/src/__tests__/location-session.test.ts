import { describe, expect, test } from "bun:test";
import {
  buildEndSessionCommand,
  pickSessionOrigin,
} from "../client/location-session";

describe("pickSessionOrigin", () => {
  test("returns null when nothing was pinned", () => {
    expect(pickSessionOrigin(null)).toBeNull();
  });

  test("returns the last-pinned location verbatim", () => {
    expect(pickSessionOrigin({ lat: 35.6586, lng: 139.7454 })).toEqual({
      lat: 35.6586,
      lng: 139.7454,
    });
  });

  // Regression guard: the play handler used to capture the *trail's*
  // first point as the session origin. That meant stopping a trail sent
  // the simulator to the trail's start (e.g. Apple Park) instead of back
  // to wherever the user had pinned (e.g. Tokyo Tower) before pressing
  // play. The origin must come from the user's last manual pin.
  test("never substitutes a trail start for the user's pin", () => {
    const trailStart = { lat: 37.3346, lng: -122.009 };
    const userPin = { lat: 35.6586, lng: 139.7454 };
    expect(pickSessionOrigin(userPin)).toEqual(userPin);
    expect(pickSessionOrigin(userPin)).not.toEqual(trailStart);
  });
});

describe("buildEndSessionCommand", () => {
  test("restores to the captured origin when one is provided", () => {
    expect(
      buildEndSessionCommand("DEVICE-123", { lat: 35.6586, lng: 139.7454 }),
    ).toBe("xcrun simctl location DEVICE-123 set 35.6586000,139.7454000");
  });

  test("clears the simulated location when no origin was captured", () => {
    expect(buildEndSessionCommand("DEVICE-123", null)).toBe(
      "xcrun simctl location DEVICE-123 clear",
    );
  });

  test("formats coordinates to 7 decimal places", () => {
    expect(buildEndSessionCommand("X", { lat: 1, lng: 2 })).toBe(
      "xcrun simctl location X set 1.0000000,2.0000000",
    );
  });

  test("preserves the device udid in the command", () => {
    const cmd = buildEndSessionCommand(
      "ABCDEF12-3456-7890-ABCD-EF1234567890",
      null,
    );
    expect(cmd).toContain("ABCDEF12-3456-7890-ABCD-EF1234567890");
  });
});
