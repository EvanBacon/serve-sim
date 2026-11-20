import { describe, expect, test } from "bun:test";
import { simctlArguments, simctlBootStatusArguments } from "../simctl";

describe("simctl boot lifecycle", () => {
  test("monitors an already-requested boot without asking bootstatus to boot again", () => {
    // `simctlArguments([])` is `simctl` plus `--set <dir>` when
    // SERVE_SIM_DEVICE_SET is configured, so this holds in either environment.
    expect(simctlBootStatusArguments("DEVICE-UDID")).toEqual([
      ...simctlArguments([]),
      "bootstatus",
      "DEVICE-UDID",
    ]);
    expect(simctlBootStatusArguments("DEVICE-UDID")).not.toContain("-b");
  });
});
