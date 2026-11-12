import { describe, expect, test } from "bun:test";
import {
  createHostRpcHandler,
  DEFAULT_PRESS_HOME_TIMEOUT_MS,
  type RunResult,
} from "../host-rpc";

const UDID = "11111111-2222-3333-4444-555555555555";

function handler(opts: {
  known?: boolean;
  pressHome?: (udid: string) => Promise<boolean>;
  pressHomeTimeoutMs?: number;
} = {}) {
  const calls: Array<[string, string[]]> = [];
  const events: string[] = [];
  const rpc = createHostRpcHandler({
    serveSimBin: "serve-sim",
    isKnownDevice: async () => opts.known ?? true,
    pressHome: opts.pressHome,
    pressHomeTimeoutMs: opts.pressHomeTimeoutMs,
    onCommandResult: (command) => events.push(command),
    run: async (file, args): Promise<RunResult> => {
      calls.push([file, args]);
      return { stdout: args.includes("launch") ? "com.apple.springboard: 1\n" : "", stderr: "", exitCode: 0 };
    },
  });
  return { rpc, calls, events };
}

describe("home", () => {
  test("uses the native pressHome path and does not shell out to simctl", async () => {
    const pressed: string[] = [];
    const { rpc, calls, events } = handler({
      pressHome: async (udid) => {
        pressed.push(udid);
        return true;
      },
    });
    expect(await rpc({ method: "home", params: { udid: UDID } })).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(pressed).toEqual([UDID]);
    expect(calls).toEqual([]);
    expect(events).toEqual([`serve-sim button home -d ${UDID}`]);
  });

  test("falls back to simctl launch when pressHome returns false", async () => {
    const { rpc, calls } = handler({ pressHome: async () => false });
    expect(await rpc({ method: "home", params: { udid: UDID } })).toMatchObject({ exitCode: 0 });
    expect(calls).toEqual([["xcrun", ["simctl", "launch", UDID, "com.apple.springboard"]]]);
  });

  test("falls back to simctl launch when pressHome throws", async () => {
    const { rpc, calls } = handler({
      pressHome: async () => {
        throw new Error("no session");
      },
    });
    expect(await rpc({ method: "home", params: { udid: UDID } })).toMatchObject({ exitCode: 0 });
    expect(calls).toEqual([["xcrun", ["simctl", "launch", UDID, "com.apple.springboard"]]]);
  });

  test("falls back to simctl launch when pressHome exceeds the timeout", async () => {
    const { rpc, calls } = handler({
      pressHomeTimeoutMs: 30,
      pressHome: () => new Promise<boolean>(() => {}),
    });
    const t0 = performance.now();
    expect(await rpc({ method: "home", params: { udid: UDID } })).toMatchObject({ exitCode: 0 });
    expect(performance.now() - t0).toBeLessThan(400);
    expect(calls).toEqual([["xcrun", ["simctl", "launch", UDID, "com.apple.springboard"]]]);
  });

  test("without pressHome, launches SpringBoard via simctl (legacy path)", async () => {
    const { rpc, calls } = handler();
    expect(await rpc({ method: "home", params: { udid: UDID } })).toMatchObject({ exitCode: 0 });
    expect(calls).toEqual([["xcrun", ["simctl", "launch", UDID, "com.apple.springboard"]]]);
  });

  test("watch home still uses the Simulator.app menu, not pressHome or simctl", async () => {
    let pressed = 0;
    const { rpc, calls } = handler({
      pressHome: async () => {
        pressed += 1;
        return true;
      },
    });
    const result = await rpc({ method: "home", params: { udid: UDID, watch: true } });
    expect(result.exitCode).toBe(0);
    expect(calls[0]?.[0]).toBe("osascript");
    expect(calls[0]?.[1].join(" ")).toContain('menu item "Home"');
    expect(pressed).toBe(0);
  });

  test("rejects a device that isn't booted", async () => {
    const { rpc, calls } = handler({ known: false, pressHome: async () => true });
    await expect(rpc({ method: "home", params: { udid: UDID } })).rejects.toThrow(
      "unknown or not booted device",
    );
    expect(calls).toEqual([]);
  });

  test("DEFAULT_PRESS_HOME_TIMEOUT_MS is a short bound, not the 10s/30s launcher waits", () => {
    expect(DEFAULT_PRESS_HOME_TIMEOUT_MS).toBe(2_000);
    expect(DEFAULT_PRESS_HOME_TIMEOUT_MS).toBeLessThan(10_000);
  });
});
