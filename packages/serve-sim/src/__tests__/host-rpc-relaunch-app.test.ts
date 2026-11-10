import { describe, expect, test } from "bun:test";
import { createHostRpcHandler, type RunResult } from "../host-rpc";

const UDID = "11111111-2222-3333-4444-555555555555";
const APP = "com.example.app";

function handler({ terminateExit = 0, known = true } = {}) {
  const calls: Array<[string, string[]]> = [];
  const rpc = createHostRpcHandler({
    serveSimBin: "serve-sim",
    isKnownDevice: async () => known,
    run: async (file, args): Promise<RunResult> => {
      calls.push([file, args]);
      if (args.includes("terminate") && terminateExit !== 0) {
        return { stdout: "", stderr: "found nothing to terminate", exitCode: terminateExit };
      }
      return { stdout: args.includes("launch") ? `${APP}: 4242\n` : "", stderr: "", exitCode: 0 };
    },
  });
  return { rpc, calls };
}

describe("relaunchApp", () => {
  test("terminates then launches the app", async () => {
    const { rpc, calls } = handler();
    expect(await rpc({ method: "relaunchApp", params: { udid: UDID, bundleId: APP } })).toEqual({
      stdout: `${APP}: 4242\n`,
      stderr: "",
      exitCode: 0,
    });
    expect(calls).toEqual([
      ["xcrun", ["simctl", "terminate", UDID, APP]],
      ["xcrun", ["simctl", "launch", UDID, APP]],
    ]);
  });

  test("still launches when the app isn't running", async () => {
    const { rpc, calls } = handler({ terminateExit: 3 });
    expect(await rpc({ method: "relaunchApp", params: { udid: UDID, bundleId: APP } })).toMatchObject({ exitCode: 0 });
    expect(calls.map(([, args]) => args[1])).toEqual(["terminate", "launch"]);
  });

  test("rejects bad bundle ids and udids without running anything", async () => {
    const { rpc, calls } = handler();
    await expect(rpc({ method: "relaunchApp", params: { udid: UDID, bundleId: "a; rm -rf ~" } })).rejects.toThrow(
      "invalid bundle id",
    );
    await expect(rpc({ method: "relaunchApp", params: { udid: UDID } })).rejects.toThrow("invalid bundle id");
    await expect(rpc({ method: "relaunchApp", params: { udid: "booted", bundleId: APP } })).rejects.toThrow(
      "invalid udid",
    );
    expect(calls).toEqual([]);
  });

  test("refuses to relaunch SpringBoard", async () => {
    const { rpc, calls } = handler();
    await expect(
      rpc({ method: "relaunchApp", params: { udid: UDID, bundleId: "com.apple.springboard" } }),
    ).rejects.toThrow("cannot relaunch SpringBoard");
    expect(calls).toEqual([]);
  });

  test("rejects a device that isn't booted", async () => {
    const { rpc, calls } = handler({ known: false });
    await expect(rpc({ method: "relaunchApp", params: { udid: UDID, bundleId: APP } })).rejects.toThrow(
      "unknown or not booted device",
    );
    expect(calls).toEqual([]);
  });
});
