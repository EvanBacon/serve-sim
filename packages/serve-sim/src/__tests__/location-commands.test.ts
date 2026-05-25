import { describe, expect, test } from "bun:test";
import { locationClearCommand, locationSetCommand } from "../client/utils/location-commands";

describe("location command formatting", () => {
  test("formats iOS simctl location commands", () => {
    expect(locationSetCommand("ios", "A-B-C", { lat: 37.3349, lng: -122.00902 }))
      .toBe("xcrun simctl location 'A-B-C' set 37.3349000,-122.0090200");
    expect(locationClearCommand("ios", "A-B-C")).toBe("xcrun simctl location 'A-B-C' clear");
  });

  test("formats Android emulator geo fix commands with longitude before latitude", () => {
    expect(locationSetCommand("android", "emulator-5554", { lat: 37.3349, lng: -122.00902 }))
      .toBe("adb -s 'emulator-5554' emu geo fix -122.0090200 37.3349000");
    expect(locationClearCommand("android", "emulator-5554")).toBeNull();
  });
});
