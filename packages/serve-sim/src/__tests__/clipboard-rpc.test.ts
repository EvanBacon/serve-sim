import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { delimiter, join } from "path";
import { tmpdir } from "os";
import { createHostRpcHandler, type RunResult } from "../host-rpc";

const UDID = "11111111-2222-3333-4444-555555555555";

describe("copyClipboard host RPC", () => {
  test("uses fixed devicectl argv and verifies exact Unicode over child stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-clipboard-"));
    const executable = join(dir, "xcrun");
    const state = join(dir, "clipboard");
    const callsPath = join(dir, "calls");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SERVE_SIM_CLIPBOARD_TEST_CALLS, JSON.stringify(args) + "\\n");
if (process.env.SERVE_SIM_CLIPBOARD_TEST_EARLY_EXIT === "1" && args[3] === "copy") {
  process.stdin.destroy();
  process.exitCode = 2;
} else if (args[3] === "copy") fs.writeFileSync(process.env.SERVE_SIM_CLIPBOARD_TEST_STATE, fs.readFileSync(0));
else if (args[3] === "paste") process.stdout.write(fs.readFileSync(process.env.SERVE_SIM_CLIPBOARD_TEST_STATE));
else process.exitCode = 64;
`);
    chmodSync(executable, 0o700);
    const previousPath = process.env.PATH;
    const previousState = process.env.SERVE_SIM_CLIPBOARD_TEST_STATE;
    const previousCalls = process.env.SERVE_SIM_CLIPBOARD_TEST_CALLS;
    const previousEarlyExit = process.env.SERVE_SIM_CLIPBOARD_TEST_EARLY_EXIT;
    process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
    process.env.SERVE_SIM_CLIPBOARD_TEST_STATE = state;
    process.env.SERVE_SIM_CLIPBOARD_TEST_CALLS = callsPath;
    let observedCommands = 0;
    const rpc = createHostRpcHandler({
      serveSimBin: "serve-sim",
      isKnownDevice: async () => true,
      onCommandResult: () => { observedCommands++; },
    });
    const text = "Cafe\u0301 👨‍👩‍👧‍👦";
    try {
      await expect(rpc({ method: "copyClipboard", params: { udid: UDID, text } })).resolves.toEqual({ verified: true });
      expect(readFileSync(state, "utf8")).toBe(text);
      expect(readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        ["devicectl", "device", "pasteboard", "copy", "--device", UDID, "--timeout", "10", "--quiet"],
        ["devicectl", "device", "pasteboard", "paste", "--device", UDID, "--timeout", "10", "--quiet"],
      ]);
      expect(observedCommands).toBe(0);
      process.env.SERVE_SIM_CLIPBOARD_TEST_EARLY_EXIT = "1";
      await expect(rpc({ method: "copyClipboard", params: { udid: UDID, text: "x".repeat(65_536) } })).rejects.toThrow("clipboard copy failed");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousState === undefined) delete process.env.SERVE_SIM_CLIPBOARD_TEST_STATE;
      else process.env.SERVE_SIM_CLIPBOARD_TEST_STATE = previousState;
      if (previousCalls === undefined) delete process.env.SERVE_SIM_CLIPBOARD_TEST_CALLS;
      else process.env.SERVE_SIM_CLIPBOARD_TEST_CALLS = previousCalls;
      if (previousEarlyExit === undefined) delete process.env.SERVE_SIM_CLIPBOARD_TEST_EARLY_EXIT;
      else process.env.SERVE_SIM_CLIPBOARD_TEST_EARLY_EXIT = previousEarlyExit;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid device or clipboard text before running commands", async () => {
    let knownChecks = 0;
    const calls: string[][] = [];
    const rpc = createHostRpcHandler({
      serveSimBin: "serve-sim",
      isKnownDevice: async () => { knownChecks++; return false; },
      run: async (_file, args) => {
        calls.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await expect(rpc({ method: "copyClipboard", params: { udid: "bad", text: "safe" } })).rejects.toThrow("invalid udid");
    await expect(rpc({ method: "copyClipboard", params: { udid: UDID, text: "safe" } })).rejects.toThrow("unknown or not booted device");
    expect(knownChecks).toBe(1);
    expect(calls).toEqual([]);

    let clipboard = "";
    const knownRpc = createHostRpcHandler({
      serveSimBin: "serve-sim",
      isKnownDevice: async () => true,
      run: async (_file, args, options) => {
        if (args[3] === "copy") clipboard = options?.input ?? "";
        return { stdout: args[3] === "paste" ? clipboard : "", stderr: "", exitCode: 0 };
      },
    });
    for (const text of ["", 4, "\ud800", "\udc00", "x".repeat(65_537), "🧪".repeat(16_385)]) {
      await expect(knownRpc({ method: "copyClipboard", params: { udid: UDID, text } })).rejects.toThrow("invalid clipboard text");
    }
    await expect(knownRpc({ method: "copyClipboard", params: { udid: UDID, text: "🧪".repeat(16_384) } })).resolves.toEqual({ verified: true });
  });

  test("passes text only on stdin and returns generic failures without clipboard content", async () => {
    const text = "$(touch /tmp/never-run)\nemoji 🧪";
    const calls: Array<{ args: string[]; input?: string; timeout?: number }> = [];
    let commands = 0;
    const rpc = createHostRpcHandler({
      serveSimBin: "serve-sim",
      isKnownDevice: async () => true,
      onCommandResult: () => { commands++; },
      run: async (_file, args, options): Promise<RunResult> => {
        calls.push({ args, input: options?.input, timeout: options?.timeout });
        return args[3] === "copy"
          ? { stdout: "", stderr: text, exitCode: 1 }
          : { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    let message = "";
    try {
      await rpc({ method: "copyClipboard", params: { udid: UDID, text } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("clipboard copy failed");
    expect(message).not.toContain(text);
    expect(calls).toEqual([
      {
        args: ["devicectl", "device", "pasteboard", "copy", "--device", UDID, "--timeout", "10", "--quiet"],
        input: text,
        timeout: 10_000,
      },
    ]);
    expect(commands).toBe(0);
  });

  test("rejects stale readback without returning clipboard content", async () => {
    const text = "secret 🥣";
    const rpc = createHostRpcHandler({
      serveSimBin: "serve-sim",
      isKnownDevice: async () => true,
      run: async (_file, args) => args[3] === "copy"
        ? { stdout: "", stderr: "", exitCode: 0 }
        : { stdout: "stale", stderr: text, exitCode: 0 },
    });
    await expect(rpc({ method: "copyClipboard", params: { udid: UDID, text } })).rejects.toThrow("clipboard verification failed");
  });

  test("releases device queue after copy failure", async () => {
    let copyAttempts = 0;
    let clipboard = "";
    const rpc = createHostRpcHandler({
      serveSimBin: "serve-sim",
      isKnownDevice: async () => true,
      run: async (_file, args, options) => {
        if (args[3] === "copy") {
          copyAttempts++;
          if (copyAttempts === 1) return { stdout: "", stderr: "", exitCode: 1 };
          clipboard = options?.input ?? "";
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: clipboard, stderr: "", exitCode: 0 };
      },
    });
    await expect(rpc({ method: "copyClipboard", params: { udid: UDID, text: "failed first" } })).rejects.toThrow("clipboard copy failed");
    await expect(rpc({ method: "copyClipboard", params: { udid: UDID, text: "works next" } })).resolves.toEqual({ verified: true });
    expect(copyAttempts).toBe(2);
  });

  test("serializes same-device copy and readback, while different devices stay independent", async () => {
    let copied = new Map<string, string>();
    let releaseFirst!: () => void;
    let firstCopyStarted!: () => void;
    let secondCopyStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstCopyStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { secondCopyStarted = resolve; });
    const firstCopyGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstDevice = UDID;
    const secondDevice = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let copyCalls = 0;
    const rpc = createHostRpcHandler({
      serveSimBin: "serve-sim",
      isKnownDevice: async () => true,
      run: async (_file, args, options) => {
        const udid = args[5]!;
        if (args[3] === "copy") {
          copyCalls++;
          copied.set(udid, options?.input ?? "");
          if (copyCalls === 1) {
            firstCopyStarted();
            await firstCopyGate;
          } else if (copyCalls === 2) secondCopyStarted();
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: copied.get(udid) ?? "", stderr: "", exitCode: 0 };
      },
    });
    const a = rpc({ method: "copyClipboard", params: { udid: firstDevice, text: "A" } });
    await firstStarted;
    const b = rpc({ method: "copyClipboard", params: { udid: secondDevice, text: "B" } });
    const secondDeviceStarted = await Promise.race([
      secondStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    releaseFirst();
    await expect(Promise.all([a, b])).resolves.toEqual([{ verified: true }, { verified: true }]);
    expect(secondDeviceStarted).toBe(true);

    let releaseSameDevice!: () => void;
    let sameDeviceCopyStarted!: () => void;
    let sameDeviceSecondCopyStarted!: () => void;
    const sameDeviceFirstStarted = new Promise<void>((resolve) => { sameDeviceCopyStarted = resolve; });
    const sameDeviceSecondStarted = new Promise<void>((resolve) => { sameDeviceSecondCopyStarted = resolve; });
    const sameDeviceGate = new Promise<void>((resolve) => { releaseSameDevice = resolve; });
    let sameDeviceCopies = 0;
    const sameDeviceRpc = createHostRpcHandler({
      serveSimBin: "serve-sim",
      isKnownDevice: async () => true,
      run: async (_file, args, options) => {
        if (args[3] === "copy") {
          sameDeviceCopies++;
          copied.set(args[5]!, options?.input ?? "");
          if (sameDeviceCopies === 1) {
            sameDeviceCopyStarted();
            await sameDeviceGate;
          } else sameDeviceSecondCopyStarted();
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: copied.get(args[5]!) ?? "", stderr: "", exitCode: 0 };
      },
    });
    const first = sameDeviceRpc({ method: "copyClipboard", params: { udid: firstDevice, text: "first" } });
    await sameDeviceFirstStarted;
    const second = sameDeviceRpc({ method: "copyClipboard", params: { udid: firstDevice, text: "second" } });
    const sameDeviceSecondStartedEarly = await Promise.race([
      sameDeviceSecondStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    releaseSameDevice();
    await expect(Promise.all([first, second])).resolves.toEqual([{ verified: true }, { verified: true }]);
    expect(sameDeviceSecondStartedEarly).toBe(false);
  });
});
