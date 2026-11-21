import { describe, expect, test } from "bun:test";
import { createHostRpcHandler, type RunResult } from "../host-rpc";

const UDID = "11111111-2222-3333-4444-555555555555";
const APP = "com.example.app";

function handler({ known = true, reply = {} as Partial<RunResult> } = {}) {
  const calls: Array<[string, string[]]> = [];
  const logged: string[] = [];
  const rpc = createHostRpcHandler({
    serveSimBin: "/opt/serve-sim.js",
    isKnownDevice: async () => known,
    onCommandResult: (cmd) => logged.push(cmd),
    run: async (file, args): Promise<RunResult> => {
      calls.push([file, args]);
      return {
        stdout: JSON.stringify({
          udid: UDID,
          bundleId: APP,
          tcc: { camera: 2, microphone: 0, photos: 3 },
          location: { Authorization: 2 },
          notifications: null,
          requested: ["camera", "bogus", 7, "location"],
        }),
        stderr: "",
        exitCode: 0,
        ...reply,
      };
    },
  });
  return { rpc, calls, logged };
}

describe("permissionsStatus", () => {
  test("runs `permissions list` and normalizes the reply", async () => {
    const { rpc, calls, logged } = handler();
    const res = (await rpc({ method: "permissionsStatus", params: { udid: UDID, bundleId: APP } })) as any;
    expect(calls).toEqual([["node", ["/opt/serve-sim.js", "permissions", "list", APP, "-d", UDID, "-q"]]]);
    expect(res.requested).toEqual(["camera", "location"]);
    expect(res.statuses).toMatchObject({
      camera: "granted",
      microphone: "denied",
      photos: "limited",
      location: "granted",
      "location-always": "unset",
      notifications: "unset",
    });
    // Polled by the panel, so it stays out of the event log.
    expect(logged).toEqual([]);
  });

  test("requested is null when the CLI couldn't read Info.plist", async () => {
    const { rpc } = handler({ reply: { stdout: JSON.stringify({ tcc: {}, requested: null }) } });
    expect(await rpc({ method: "permissionsStatus", params: { udid: UDID, bundleId: APP } })).toMatchObject({
      requested: null,
    });
  });

  test("surfaces CLI failures and unreadable output", async () => {
    await expect(
      handler({ reply: { exitCode: 1, stderr: "No booted simulator." } }).rpc({
        method: "permissionsStatus",
        params: { udid: UDID, bundleId: APP },
      }),
    ).rejects.toThrow("No booted simulator.");
    await expect(
      handler({ reply: { stdout: "not json" } }).rpc({ method: "permissionsStatus", params: { udid: UDID, bundleId: APP } }),
    ).rejects.toThrow("unreadable permissions list output");
  });

  test("validates params before running anything", async () => {
    const { rpc, calls } = handler();
    await expect(rpc({ method: "permissionsStatus", params: { udid: "booted", bundleId: APP } })).rejects.toThrow(
      "invalid udid",
    );
    await expect(rpc({ method: "permissionsStatus", params: { udid: UDID, bundleId: "-rf" } })).rejects.toThrow(
      "invalid bundle id",
    );
    await expect(rpc({ method: "permissionsStatus", params: { udid: UDID } })).rejects.toThrow("invalid bundle id");
    expect(calls).toEqual([]);
  });

  test("rejects a device that isn't booted", async () => {
    const { rpc, calls } = handler({ known: false });
    await expect(rpc({ method: "permissionsStatus", params: { udid: UDID, bundleId: APP } })).rejects.toThrow(
      "unknown or not booted device",
    );
    expect(calls).toEqual([]);
  });

  test("permissions accepts every catalogue service", async () => {
    const { rpc } = handler();
    for (const service of ["speech", "faceid", "user-tracking", "homekit", "location-always"]) {
      await expect(
        rpc({ method: "permissions", params: { udid: UDID, bundleId: APP, action: "grant", service } }),
      ).resolves.toBeDefined();
    }
  });
});
