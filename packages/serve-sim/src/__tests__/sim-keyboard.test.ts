import { describe, expect, test } from "bun:test";
import {
  HID_KEY_R,
  createSimKeyState,
  isReloadShortcut,
} from "../client/utils/sim-keyboard";

const META_LEFT = 0xe3;
const SHIFT_LEFT = 0xe1;
const KEY_A = 0x04;

function key(code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) {
  return { code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("isReloadShortcut", () => {
  test("matches Cmd+R only", () => {
    expect(isReloadShortcut(key("KeyR", { metaKey: true }))).toBe(true);
    expect(isReloadShortcut(key("KeyR"))).toBe(false);
    // Cmd+Shift+R stays a browser hard reload; Ctrl/Alt chords go to the sim.
    expect(isReloadShortcut(key("KeyR", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isReloadShortcut(key("KeyR", { metaKey: true, ctrlKey: true }))).toBe(false);
    expect(isReloadShortcut(key("KeyR", { metaKey: true, altKey: true }))).toBe(false);
    expect(isReloadShortcut(key("KeyT", { metaKey: true }))).toBe(false);
  });
});

describe("createSimKeyState", () => {
  test("forwards a plain key press and release", () => {
    const keys = createSimKeyState();
    expect(keys.forward("down", HID_KEY_R)).toEqual([{ type: "down", usage: HID_KEY_R }]);
    expect(keys.forward("up", HID_KEY_R)).toEqual([{ type: "up", usage: HID_KEY_R }]);
    expect(keys.held.size).toBe(0);
  });

  test("releasing Cmd also releases keys whose keyup macOS swallowed", () => {
    // macOS browsers never fire keyup for A in Cmd+A when Cmd is let go
    // first; without this the sim would keep A held and drop the next A.
    const keys = createSimKeyState();
    keys.forward("down", META_LEFT);
    keys.forward("down", KEY_A);
    expect(keys.forward("up", META_LEFT)).toEqual([
      { type: "up", usage: KEY_A },
      { type: "up", usage: META_LEFT },
    ]);
    expect(keys.held.size).toBe(0);
    // A late keyup for the already-released key is not sent twice.
    expect(keys.forward("up", KEY_A)).toEqual([]);
  });

  test("releasing Cmd keeps other held modifiers down", () => {
    const keys = createSimKeyState();
    keys.forward("down", SHIFT_LEFT);
    keys.forward("down", META_LEFT);
    expect(keys.forward("up", META_LEFT)).toEqual([{ type: "up", usage: META_LEFT }]);
    expect([...keys.held]).toEqual([SHIFT_LEFT]);
  });

  test("releaseAll lifts every held key once", () => {
    const keys = createSimKeyState();
    keys.forward("down", META_LEFT);
    keys.forward("down", HID_KEY_R);
    expect(keys.releaseAll()).toEqual([
      { type: "up", usage: META_LEFT },
      { type: "up", usage: HID_KEY_R },
    ]);
    expect(keys.releaseAll()).toEqual([]);
    // The browser's own keyup after the release is swallowed.
    expect(keys.forward("up", META_LEFT)).toEqual([]);
  });

  test("reloadEvents sends a clean, unmodified R tap", () => {
    // React Native reloads on a bare `r` with no first responder; the guest
    // ignores Cmd+R from Indigo, so any held Cmd must be lifted first.
    const keys = createSimKeyState();
    keys.forward("down", META_LEFT);
    expect(keys.reloadEvents()).toEqual({
      release: [{ type: "up", usage: META_LEFT }],
      tap: HID_KEY_R,
    });
    expect(keys.held.size).toBe(0);
  });
});
