import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { axTreeHasSoftwareKeyboard, readHardwareKeyboardState, writeHardwareKeyboardState } from "../hardware-keyboard-state";

const UDID = "TEST-UDID";
const roots: string[] = [];

function setup(booted = true) {
  const root = mkdtempSync(join(tmpdir(), "serve-sim-hwkbd-"));
  roots.push(root);
  const opts = { stateDir: join(root, "state"), devicesDir: join(root, "devices") };
  const bootstrap = join(opts.devicesDir, UDID, "data/var/run/launchd_bootstrap.plist");
  if (booted) {
    mkdirSync(join(bootstrap, ".."), { recursive: true });
    writeFileSync(bootstrap, "");
  }
  return { opts, bootstrap, file: join(opts.stateDir, `hardware-keyboard-${UDID}.json`) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("hardware keyboard state", () => {
  test("round trips an explicit value within one boot", () => {
    const { opts } = setup();
    expect(readHardwareKeyboardState(UDID, opts)).toBeNull();
    writeHardwareKeyboardState(UDID, false, opts);
    expect(readHardwareKeyboardState(UDID, opts)).toBe(false);
    writeHardwareKeyboardState(UDID, true, opts);
    expect(readHardwareKeyboardState(UDID, opts)).toBe(true);
  });

  test("a reboot (new bootstrap mtime) ignores the previous boot's value", () => {
    const { opts, bootstrap } = setup();
    writeHardwareKeyboardState(UDID, false, opts);
    const later = new Date(Date.now() + 60_000);
    utimesSync(bootstrap, later, later);
    expect(readHardwareKeyboardState(UDID, opts)).toBeNull();
  });

  test("a missing bootstrap file reads null and skips the write", () => {
    const { opts, file } = setup(false);
    writeHardwareKeyboardState(UDID, true, opts);
    expect(existsSync(file)).toBe(false);
    expect(readHardwareKeyboardState(UDID, opts)).toBeNull();
  });

  test("corrupt json reads null", () => {
    const { opts, file } = setup();
    mkdirSync(opts.stateDir, { recursive: true });
    writeFileSync(file, "{not json");
    expect(readHardwareKeyboardState(UDID, opts)).toBeNull();
  });

  test("a non-boolean enabled reads null", () => {
    const { opts, file } = setup();
    mkdirSync(opts.stateDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ enabled: "yes", bootKey: 1 }));
    expect(readHardwareKeyboardState(UDID, opts)).toBeNull();
  });
});

describe("axTreeHasSoftwareKeyboard", () => {
  const node = (AXUniqueId: string | null, children: unknown[] = []) => ({ AXUniqueId, AXLabel: AXUniqueId, children });

  test("finds a nested software keyboard key", () => {
    const tree = [node(null, [node("searchField"), node(null, [node("q"), node("space")])])];
    expect(axTreeHasSoftwareKeyboard(tree)).toBe(true);
  });

  test("finds shift on its own", () => {
    expect(axTreeHasSoftwareKeyboard([node(null, [node("shift")])])).toBe(true);
  });

  test("a tree without keyboard keys is false", () => {
    const tree = [node(null, [node("searchField"), node("Space Station"), node(null, [node(null)])])];
    expect(axTreeHasSoftwareKeyboard(tree)).toBe(false);
  });

  test("empty or odd shapes are false", () => {
    expect(axTreeHasSoftwareKeyboard([])).toBe(false);
    expect(axTreeHasSoftwareKeyboard(null)).toBe(false);
    expect(axTreeHasSoftwareKeyboard("space")).toBe(false);
    expect(axTreeHasSoftwareKeyboard({ AXUniqueId: 1, children: "space" })).toBe(false);
    expect(axTreeHasSoftwareKeyboard([{ AXLabel: "space" }])).toBe(false);
  });
});
