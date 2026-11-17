import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createHostRpcHandler, type RunResult } from "../host-rpc";
import { simctlArguments } from "../simctl";

// The toolbar's screenshot and location actions run `simctl io … screenshot`
// and `simctl location …` on the host. This pins the argv they hand xcrun
// (in whatever device set this process targets), the coordinate formatting
// simctl parses, which inputs are refused before anything runs, and how a
// simctl failure comes back to the page.

const UDID = "11111111-2222-3333-4444-555555555555";
const HOME = "/Users/someone";
const DESKTOP = join(HOME, "Desktop");

function handler(opts: { known?: boolean; result?: RunResult } = {}) {
  const calls: Array<[string, string[]]> = [];
  const rpc = createHostRpcHandler({
    serveSimBin: "serve-sim",
    homeDir: HOME,
    isKnownDevice: async () => opts.known ?? true,
    run: async (file, args): Promise<RunResult> => {
      calls.push([file, args]);
      return opts.result ?? { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  return { rpc, calls };
}

describe("screenshot", () => {
  test("writes a timestamped PNG on the Desktop and returns its path", async () => {
    const { rpc, calls } = handler();
    const out = (await rpc({ method: "screenshot", params: { udid: UDID } })) as { path: string; exitCode: number };
    expect(out.exitCode).toBe(0);
    expect(out.path.startsWith(`${DESKTOP}/serve-sim-screenshot-`)).toBe(true);
    expect(out.path).toMatch(/\/serve-sim-screenshot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.png$/);
    expect(calls).toEqual([["xcrun", simctlArguments(["io", UDID, "screenshot", out.path])]]);
  });

  test("a display (the iPhone Duo's inner panel) goes before the path as --display=", async () => {
    const { rpc, calls } = handler();
    const out = (await rpc({ method: "screenshot", params: { udid: UDID, display: "primary-1" } })) as { path: string };
    expect(calls).toEqual([["xcrun", simctlArguments(["io", UDID, "screenshot", "--display=primary-1", out.path])]]);
  });

  test("a failed capture reports simctl's error and no path", async () => {
    const failure = { stdout: "", stderr: "Error: No such display", exitCode: 1 };
    const { rpc } = handler({ result: failure });
    expect(await rpc({ method: "screenshot", params: { udid: UDID } })).toEqual({ ...failure, path: "" });
  });

  test("an unknown display, a malformed udid, or an unknown device runs nothing", async () => {
    const { rpc, calls } = handler();
    await expect(rpc({ method: "screenshot", params: { udid: UDID, display: "--all" } })).rejects.toThrow("invalid display");
    await expect(rpc({ method: "screenshot", params: { udid: "booted" } })).rejects.toThrow("invalid udid");
    const unknown = handler({ known: false });
    await expect(unknown.rpc({ method: "screenshot", params: { udid: UDID } })).rejects.toThrow(`unknown or not booted device: ${UDID}`);
    expect([...calls, ...unknown.calls]).toEqual([]);
  });
});

describe("location", () => {
  test("sets lat,lng with seven decimals, the form simctl parses", async () => {
    const { rpc, calls } = handler();
    await rpc({ method: "location", params: { udid: UDID, lat: 37.7749, lng: -122.4194 } });
    await rpc({ method: "location", params: { udid: UDID, lat: -90, lng: 180 } });
    expect(calls).toEqual([
      ["xcrun", simctlArguments(["location", UDID, "set", "37.7749000,-122.4194000"])],
      ["xcrun", simctlArguments(["location", UDID, "set", "-90.0000000,180.0000000"])],
    ]);
  });

  test("no coordinates clears the simulated location", async () => {
    const { rpc, calls } = handler();
    expect(await rpc({ method: "location", params: { udid: UDID } })).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(calls).toEqual([["xcrun", simctlArguments(["location", UDID, "clear"])]]);
  });

  test("out-of-range, non-numeric, or half-given coordinates run nothing", async () => {
    const { rpc, calls } = handler();
    for (const [params, error] of [
      [{ lat: 90.5, lng: 0 }, "invalid lat"],
      [{ lat: 0, lng: -180.5 }, "invalid lng"],
      [{ lat: "37.7", lng: 0 }, "invalid lat"],
      [{ lat: Number.NaN, lng: 0 }, "invalid lat"],
      [{ lat: 0, lng: Number.POSITIVE_INFINITY }, "invalid lng"],
      [{ lng: 10 }, "invalid lat"],
      [{ lat: 10 }, "invalid lng"],
    ] as const) {
      await expect(rpc({ method: "location", params: { udid: UDID, ...params } })).rejects.toThrow(error);
    }
    expect(calls).toEqual([]);
  });

  test("simctl's failure is returned as-is", async () => {
    const failure = { stdout: "", stderr: "Invalid device state", exitCode: 149 };
    const { rpc } = handler({ result: failure });
    expect(await rpc({ method: "location", params: { udid: UDID, lat: 1, lng: 2 } })).toEqual(failure);
  });
});
