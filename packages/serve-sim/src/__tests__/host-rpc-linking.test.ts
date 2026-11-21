import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AxSnapshot } from "../ax-shared";
import { createHostRpcHandler, openUrlError, SPOTLIGHT_SWIPE, type LinkingInput, type RunResult } from "../host-rpc";
import { simctlArguments } from "../simctl";

const UDID = "11111111-2222-3333-4444-555555555555";
const APP = "com.example.app";

const dir = mkdtempSync(join(tmpdir(), "serve-sim-host-rpc-linking-"));
const APP_PATH = join(dir, "Example.app");
mkdirSync(APP_PATH);
writeFileSync(join(APP_PATH, "Info.plist"), "plist");
writeFileSync(join(APP_PATH, "Example"), "binary");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const INFO = {
  CFBundleDisplayName: "Example",
  CFBundleExecutable: "Example",
  CFBundleURLTypes: [{ CFBundleURLSchemes: ["Example", "example-dev"] }],
};

const LS_115 = [
  "An error was encountered processing the command (domain=LSApplicationWorkspaceErrorDomain, code=115):",
  "Simulator device failed to open nosuch://x.",
  "Underlying error (domain=LSApplicationWorkspaceErrorDomain, code=115):",
  "\tThe operation couldn’t be completed. (LSApplicationWorkspaceErrorDomain error 115.)",
].join("\n");

function handler({
  known = true,
  openurlExit = 0,
  input,
  info = INFO,
}: { known?: boolean; openurlExit?: number; input?: LinkingInput; info?: unknown } = {}) {
  const calls: Array<[string, string[]]> = [];
  const logged: string[] = [];
  const homes: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const rpc = createHostRpcHandler({
    serveSimBin: "serve-sim",
    isKnownDevice: async () => known,
    onCommandResult: (command) => logged.push(command),
    pressHome: async (udid) => { homes.push(udid); return true; },
    linkingInput: input,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    run: async (file, args): Promise<RunResult> => {
      calls.push([file, args]);
      if (args.includes("get_app_container")) return { stdout: `${APP_PATH}\n`, stderr: "", exitCode: 0 };
      if (file === "plutil") return { stdout: JSON.stringify(info), stderr: "", exitCode: 0 };
      if (file === "codesign") return { stdout: "", stderr: "", exitCode: 0 };
      if (file === "otool") {
        return { stdout: "000000010000038c\t696c703c 3c3e7473 \n", stderr: "", exitCode: 0 };
      }
      if (args.includes("openurl") && openurlExit) return { stdout: "", stderr: LS_115, exitCode: openurlExit };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  return { rpc, calls, logged, homes, sleeps };
}

describe("openUrl", () => {
  test("runs simctl openurl with a fixed argv", async () => {
    const { rpc, calls, logged } = handler();
    expect(await rpc({ method: "openUrl", params: { udid: UDID, url: "example://a b?c=$(whoami)" } })).toMatchObject({ exitCode: 0 });
    expect(calls).toEqual([["xcrun", simctlArguments(["openurl", UDID, "example://a b?c=$(whoami)"])]]);
    expect(logged).toHaveLength(1);
  });

  test("turns 'no handler' into a one-line reason", async () => {
    const { rpc } = handler({ openurlExit: 115 });
    expect(await rpc({ method: "openUrl", params: { udid: UDID, url: "NoSuch://x" } })).toMatchObject({
      exitCode: 115,
      stderr: "No app handles nosuch://",
    });
  });

  test("validates before running anything", async () => {
    const { rpc, calls } = handler();
    for (const url of [undefined, 3, "", "no-scheme", "-oops:x", "a://\n", "a://\u0000", `a://${"x".repeat(2048)}`]) {
      await expect(rpc({ method: "openUrl", params: { udid: UDID, url } })).rejects.toThrow("invalid url");
    }
    await expect(rpc({ method: "openUrl", params: { udid: "booted", url: "a://" } })).rejects.toThrow("invalid udid");
    expect(calls).toEqual([]);
  });

  test("refuses devices this server doesn't serve", async () => {
    const { rpc, calls } = handler({ known: false });
    await expect(rpc({ method: "openUrl", params: { udid: UDID, url: "a://" } })).rejects.toThrow("unknown or not booted");
    expect(calls).toEqual([]);
  });
});

describe("openUrlError", () => {
  test("falls back to the first stderr line or the exit code", () => {
    expect(openUrlError("x://", "\n  Something broke\nmore", 1)).toBe("Something broke");
    expect(openUrlError("x://", "", 2)).toBe("simctl openurl failed (exit 2)");
  });
});

describe("linkingInfo", () => {
  test("returns schemes, universal-link domains and the display name without logging", async () => {
    const { rpc, calls, logged } = handler();
    expect(await rpc({ method: "linkingInfo", params: { udid: UDID, bundleId: APP } })).toEqual({
      displayName: "Example",
      schemes: ["example", "example-dev"],
      domains: [],
    });
    expect(calls.map(([file]) => file)).toEqual(["xcrun", "plutil", "codesign", "otool"]);
    expect(calls[2]).toEqual(["codesign", ["-d", "--entitlements", "-", "--xml", APP_PATH]]);
    expect(calls[3]).toEqual(["otool", ["-X", "-s", "__TEXT", "__entitlements", join(APP_PATH, "Example")]]);
    expect(logged).toEqual([]);
  });

  test("validates the bundle id", async () => {
    const { rpc, calls } = handler();
    await expect(rpc({ method: "linkingInfo", params: { udid: UDID, bundleId: "-rf" } })).rejects.toThrow("invalid bundle id");
    expect(calls).toEqual([]);
  });
});

function fakeInput(snapshots: AxSnapshot[] = []) {
  const events: string[] = [];
  const input: LinkingInput = {
    touches: async (udid, steps) => { events.push(`touches ${udid} ${steps.length}`); },
    tap: async (_udid, p) => { events.push(`tap ${p.x.toFixed(2)},${p.y.toFixed(2)}`); },
    paste: async (_udid, text) => { events.push(`paste ${text}`); },
    snapshot: async () => snapshots.shift() ?? { screen: { width: 400, height: 800 }, elements: [] },
  };
  return { input, events };
}

describe("linkingAction", () => {
  test("launch and terminate run simctl", async () => {
    const { rpc, calls } = handler();
    await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "launch" } });
    await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "terminate" } });
    expect(calls).toEqual([
      ["xcrun", simctlArguments(["launch", UDID, APP])],
      ["xcrun", simctlArguments(["terminate", UDID, APP])],
    ]);
  });

  test("spotlight: Home, swipe, wait, paste the display name", async () => {
    const { input, events } = fakeInput();
    const { rpc, homes, sleeps } = handler({ input });
    expect(await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "spotlight" } })).toMatchObject({ exitCode: 0 });
    expect(homes).toEqual([UDID]);
    expect(events).toEqual([`touches ${UDID} ${SPOTLIGHT_SWIPE.length}`, "paste Example"]);
    expect(sleeps).toEqual([800, 1000]);
    expect(SPOTLIGHT_SWIPE.map((s) => [s.type, s.x, s.y])).toEqual([
      ["begin", 0.5, 0.35], ["move", 0.5, 0.45], ["move", 0.5, 0.6], ["end", 0.5, 0.62],
    ]);
  });

  test("spotlight pastes a typed query; SpringBoard needs one", async () => {
    const { input, events } = fakeInput();
    const { rpc } = handler({ input });
    await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "spotlight", query: "  weather " } });
    expect(events.at(-1)).toBe("paste weather");
    expect(await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: "com.apple.springboard", action: "spotlight" } }))
      .toMatchObject({ exitCode: 1, stderr: "Type something to search for" });
  });

  test("input failures come back inline", async () => {
    const { input } = fakeInput();
    input.paste = async () => { throw new Error("Cmd+V was not delivered"); };
    const { rpc } = handler({ input });
    expect(await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "spotlight" } }))
      .toMatchObject({ exitCode: 1, stderr: "Cmd+V was not delivered" });
  });

  test("spotlight and settings need the input session", async () => {
    const { rpc } = handler();
    for (const action of ["spotlight", "settings", "notificationSettings"]) {
      const res = await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action } });
      expect(res.exitCode).toBe(1);
      expect(String(res.stderr)).toMatch(/input session/);
    }
  });

  test("settings relaunches Settings at its root and reports a navigation failure", async () => {
    const { input } = fakeInput();
    const { rpc, calls } = handler({ input });
    const res = await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "settings" } });
    expect(res).toMatchObject({ exitCode: 1, stderr: "Settings didn't show its main list" });
    expect(calls.slice(-2)).toEqual([
      ["xcrun", simctlArguments(["terminate", UDID, "com.apple.Preferences"])],
      ["xcrun", simctlArguments(["openurl", UDID, "App-prefs:"])],
    ]);
  });

  test("settings succeeds through Apps → app", async () => {
    const screen = { width: 400, height: 800 };
    const e = (id: string, label: string, role: string, y: number) => ({
      id, path: id, label, value: "", role, type: role === "heading" ? "Heading" : "Button", enabled: true,
      frame: { x: 16, y, width: 370, height: 52 },
    });
    const root: AxSnapshot = { screen, elements: [e("h", "Settings", "heading", 70), e("com.apple.settings.apps", "Apps", "button", 400)] };
    const apps: AxSnapshot = { screen, elements: [e("h", "Apps", "heading", 70), e(APP, "Example", "button", 300)] };
    const page: AxSnapshot = { screen, elements: [e("BackButton", "Apps", "back button", 60), e("h", "Example", "heading", 70)] };
    // Each tap moves to the next screen; reads repeat the current one.
    const screens = [root, apps, page];
    const events: string[] = [];
    const input: LinkingInput = {
      touches: async () => { events.push("touches"); },
      tap: async (_u, p) => { events.push(`tap ${p.x.toFixed(2)},${p.y.toFixed(2)}`); if (screens.length > 1) screens.shift(); },
      paste: async () => {},
      snapshot: async () => screens[0]!,
    };
    const { rpc } = handler({ input });
    expect(await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "settings" } })).toMatchObject({ exitCode: 0 });
    expect(events).toEqual(["tap 0.50,0.53", "tap 0.50,0.41"]);
  });

  test("validates action, query and bundle", async () => {
    const { input } = fakeInput();
    const { rpc, calls } = handler({ input });
    const call = (params: Record<string, unknown>) => rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, ...params } });
    await expect(call({ action: "shell" })).rejects.toThrow("invalid action");
    await expect(call({ action: "launch", query: "x" })).rejects.toThrow("invalid query");
    await expect(call({ action: "spotlight", query: "a\nb" })).rejects.toThrow("invalid query");
    await expect(call({ action: "spotlight", query: "x".repeat(257) })).rejects.toThrow("invalid query");
    await expect(call({ action: "spotlight", query: 5 })).rejects.toThrow("invalid query");
    await expect(call({ action: "terminate", bundleId: "com.apple.springboard" })).rejects.toThrow("cannot terminate SpringBoard");
    await expect(call({ action: "launch", bundleId: "../x" })).rejects.toThrow("invalid bundle id");
    expect(calls).toEqual([]);
  });

  test("one linking action at a time per device", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { input } = fakeInput();
    input.touches = async () => { await gate; };
    const { rpc } = handler({ input });
    const first = rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "spotlight" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "launch" } }))
      .toMatchObject({ exitCode: 1, stderr: "Another linking action is still running" });
    release();
    expect(await first).toMatchObject({ exitCode: 0 });
    expect(await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "launch" } })).toMatchObject({ exitCode: 0 });
  });
});

const ALERT_SNAPSHOT: AxSnapshot = {
  screen: { width: 400, height: 800 },
  elements: [
    { id: "t", path: "t", label: "Open in “Example”?", value: "", role: "text", type: "StaticText", enabled: true, frame: { x: 70, y: 400, width: 260, height: 20 } },
    { id: "c", path: "c", label: "Cancel", value: "", role: "button", type: "Button", enabled: true, frame: { x: 60, y: 440, width: 140, height: 48 } },
    { id: "o", path: "o", label: "Open", value: "", role: "button", type: "Button", enabled: true, frame: { x: 200, y: 440, width: 140, height: 48 } },
  ],
};
const CLEAR: AxSnapshot = { screen: { width: 400, height: 800 }, elements: [] };

/** Input whose screen shows `alerts` stacked confirmations; a button tap pops one. */
function alertInput(alerts: number, { appearOnOpenurl = false, stuck = false } = {}) {
  let pending = alerts;
  const events: string[] = [];
  const input: LinkingInput = {
    touches: async () => { events.push("touches"); },
    tap: async (_u, p) => {
      events.push(p.x < 0.5 ? "tap Cancel" : "tap Open");
      if (!stuck && pending > 0) pending--;
    },
    paste: async (_u, text) => { events.push(`paste ${text}`); },
    snapshot: async () => (pending > 0 ? ALERT_SNAPSHOT : CLEAR),
  };
  return { input, events, openurl: () => { if (appearOnOpenurl) pending++; } };
}

describe("openUrl confirmation alert", () => {
  function alertHandler(input: LinkingInput, onOpenurl: () => void) {
    let clock = 0;
    const calls: string[] = [];
    const rpc = createHostRpcHandler({
      serveSimBin: "serve-sim",
      isKnownDevice: async () => true,
      pressHome: async () => true,
      linkingInput: input,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      run: async (file, args) => {
        calls.push(args.includes("openurl") ? "openurl" : args.includes("get_app_container") ? "container" : file);
        if (args.includes("openurl")) onOpenurl();
        if (args.includes("get_app_container")) return { stdout: `${APP_PATH}\n`, stderr: "", exitCode: 0 };
        if (file === "plutil") return { stdout: JSON.stringify(INFO), stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    return { rpc, calls, elapsed: () => clock };
  }

  test("taps Open on the confirmation iOS shows for a custom scheme", async () => {
    const { input, events, openurl } = alertInput(0, { appearOnOpenurl: true });
    const { rpc } = alertHandler(input, openurl);
    expect(await rpc({ method: "openUrl", params: { udid: UDID, url: "example://hello" } })).toMatchObject({ exitCode: 0 });
    expect(events).toEqual(["tap Open"]);
  });

  test("cancels stray alerts from earlier opens first, then confirms its own", async () => {
    const { input, events, openurl } = alertInput(2, { appearOnOpenurl: true });
    const { rpc, calls } = alertHandler(input, openurl);
    expect(await rpc({ method: "openUrl", params: { udid: UDID, url: "example://hello" } })).toMatchObject({ exitCode: 0 });
    expect(events).toEqual(["tap Cancel", "tap Cancel", "tap Open"]);
    expect(calls).toEqual(["openurl"]);
  });

  test("returns promptly when no confirmation comes (https, already-trusted)", async () => {
    const { input, events, openurl } = alertInput(0);
    const { rpc, elapsed } = alertHandler(input, openurl);
    expect(await rpc({ method: "openUrl", params: { udid: UDID, url: "https://example.com" } })).toMatchObject({ exitCode: 0 });
    expect(events).toEqual([]);
    expect(elapsed()).toBeLessThan(2000);
  });

  test("reports an alert that won't close, within a bound", async () => {
    const { input, openurl } = alertInput(0, { appearOnOpenurl: true, stuck: true });
    const { rpc, elapsed } = alertHandler(input, openurl);
    // The stuck alert only shows after openurl, so the stray check passes.
    expect(await rpc({ method: "openUrl", params: { udid: UDID, url: "example://hello" } })).toMatchObject({
      exitCode: 1,
      stderr: "iOS asked to confirm opening the link, and the alert didn't close",
    });
    expect(elapsed()).toBeLessThan(5000);
  });

  test("Spotlight cancels a stray alert before Home and the swipe", async () => {
    const { input, events, openurl } = alertInput(1);
    const { rpc } = alertHandler(input, openurl);
    expect(await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "spotlight" } })).toMatchObject({ exitCode: 0 });
    expect(events).toEqual(["tap Cancel", "touches", "paste Example"]);
  });

  test("App Settings cancels a stray alert before relaunching Settings", async () => {
    const { input, events, openurl } = alertInput(1);
    const { rpc, calls } = alertHandler(input, openurl);
    const res = await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "settings" } });
    // The fake never shows a Settings screen; the point is the order.
    expect(res.stderr).toBe("Settings didn't show its main list");
    expect(events[0]).toBe("tap Cancel");
    expect(calls.slice(-2)).toEqual(["xcrun", "openurl"]);
  });

  test("a stray alert that won't close fails the token inline", async () => {
    const { input, events, openurl } = alertInput(1, { stuck: true });
    const { rpc } = alertHandler(input, openurl);
    const res = await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "notificationSettings" } });
    expect(res).toMatchObject({ exitCode: 1 });
    expect(String(res.stderr)).toMatch(/Open in “Example”\?.*didn't close/);
    expect(events.every((e) => e === "tap Cancel")).toBe(true);
    expect(events.length).toBeLessThanOrEqual(6);
  });
});

describe("linkingAction on system UI and nameless apps", () => {
  test("app tokens refuse system surfaces inline; Search needs a query there", async () => {
    const { input } = fakeInput();
    const { rpc, calls } = handler({ input });
    for (const action of ["launch", "terminate", "settings", "notificationSettings"]) {
      expect(await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: "com.apple.Spotlight", action } })).toMatchObject({
        exitCode: 1,
        stderr: "com.apple.Spotlight is system UI, not an app; bring an app to the front first",
      });
    }
    expect(await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: "com.apple.Spotlight", action: "spotlight" } }))
      .toMatchObject({ exitCode: 1, stderr: "Type something to search for" });
    expect(calls).toEqual([]);
  });

  test("App Settings explains a bundle with no display name", async () => {
    const { input } = fakeInput();
    const { rpc } = handler({ input, info: { CFBundleExecutable: "Example" } });
    expect(await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: APP, action: "settings" } })).toMatchObject({
      exitCode: 1,
      stderr: `${APP} has no CFBundleDisplayName or CFBundleName, so it can't be found in Settings › Apps`,
    });
  });

  test("App Settings explains an app that isn't installed", async () => {
    const { input } = fakeInput();
    const rpc = createHostRpcHandler({
      serveSimBin: "serve-sim",
      isKnownDevice: async () => true,
      linkingInput: input,
      run: async () => ({ stdout: "", stderr: "No such app", exitCode: 2 }),
    });
    expect(await rpc({ method: "linkingAction", params: { udid: UDID, bundleId: "com.example.gone", action: "notificationSettings" } }))
      .toMatchObject({ exitCode: 1, stderr: "com.example.gone isn't installed on this simulator" });
  });
});
