import { describe, expect, test } from "bun:test";
import { simctlBootStatusArguments } from "../simctl";

describe("simctl boot lifecycle", () => {
  test("monitors an already-requested boot without asking bootstatus to boot again", () => {
    expect(simctlBootStatusArguments("DEVICE-UDID")).toEqual([
      "simctl",
      "bootstatus",
      "DEVICE-UDID",
    ]);
    expect(simctlBootStatusArguments("DEVICE-UDID")).not.toContain("-b");
  });
});
