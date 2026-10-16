import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { existsSync, rmSync } from "fs";
import { createHostRpcHandler, INSTALL_REQUIRES_EXEC, type RunResult } from "../host-rpc";

// Installing (and launching) an arbitrary .ipa is host code execution, so it
// needs `--allow-exec` like the shell does — even for a loopback page.

const UDID = "11111111-2222-3333-4444-555555555555";

function handler(allowExec: boolean) {
  const calls: Array<[string, string[]]> = [];
  const rpc = createHostRpcHandler({
    serveSimBin: "serve-sim",
    isKnownDevice: async () => true,
    allowExec,
    run: async (file, args): Promise<RunResult> => {
      calls.push([file, args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  return { rpc, calls };
}

describe("installApp requires allowExec", () => {
  test("refused without allowExec; simctl install never runs", async () => {
    const { rpc, calls } = handler(false);
    const path = `/tmp/serve-sim-install-${randomUUID()}.ipa`;
    await expect(rpc({ method: "installApp", params: { udid: UDID, path } })).rejects.toThrow(INSTALL_REQUIRES_EXEC);
    expect(calls).toEqual([]);
  });

  test("install uploads cannot be staged without allowExec", async () => {
    const { rpc } = handler(false);
    const path = `/tmp/serve-sim-install-${randomUUID()}.ipa`;
    try {
      await expect(rpc({ method: "uploadChunk", params: { path, data: "AA==" } })).rejects.toThrow(INSTALL_REQUIRES_EXEC);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("media uploads still work without allowExec", async () => {
    const { rpc } = handler(false);
    const path = `/tmp/serve-sim-upload-${randomUUID()}.png`;
    try {
      expect(await rpc({ method: "uploadChunk", params: { path, data: "AA==" } })).toEqual({ ok: true });
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("with allowExec, installApp runs simctl install", async () => {
    const { rpc, calls } = handler(true);
    const path = `/tmp/serve-sim-install-${randomUUID()}.ipa`;
    expect(await rpc({ method: "installApp", params: { udid: UDID, path } })).toMatchObject({ exitCode: 0 });
    expect(calls).toEqual([["xcrun", ["simctl", "install", UDID, path]]]);
  });
});
