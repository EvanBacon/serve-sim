import { describe, expect, test } from "bun:test";
import { HID_KEY_R, createSimKeyState } from "../client/utils/sim-keyboard";

const META_LEFT = 0xe3;
const KEY_A = 0x04;

describe("createSimKeyState", () => {
  test("forwards a plain key press and release", () => {
    const keys = createSimKeyState();
    expect(keys.forward("down", HID_KEY_R)).toEqual([{ type: "down", usage: HID_KEY_R }]);
    expect(keys.forward("up", HID_KEY_R)).toEqual([{ type: "up", usage: HID_KEY_R }]);
    expect(keys.held.size).toBe(0);
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

  test("reloadEvents lifts an R left down by Cmd+R before tapping", () => {
    // macOS browsers never fire keyup for R in Cmd+R, so the sim keeps R
    // held; a reload tap sent on top of it is swallowed by the guest.
    const keys = createSimKeyState();
    keys.forward("down", META_LEFT);
    keys.forward("down", HID_KEY_R);
    keys.forward("up", META_LEFT);
    expect(keys.reloadEvents()).toEqual({
      release: [{ type: "up", usage: HID_KEY_R }],
      tap: HID_KEY_R,
    });
    expect(keys.restoreEvents()).toEqual([]);
    expect(keys.held.size).toBe(0);
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
    expect(keys.restoreEvents()).toEqual([{ type: "down", usage: META_LEFT }]);
  });

  test("restoreEvents re-presses still-held modifiers but not other keys", () => {
    const keys = createSimKeyState();
    keys.forward("down", META_LEFT);
    keys.forward("down", KEY_A);
    const { release } = keys.reloadEvents();
    expect(release).toEqual([
      { type: "up", usage: META_LEFT },
      { type: "up", usage: KEY_A },
    ]);
    expect(keys.restoreEvents()).toEqual([{ type: "down", usage: META_LEFT }]);
    expect([...keys.held]).toEqual([META_LEFT]);
    // Letting go of Cmd afterwards is forwarded, so Cmd isn't left stuck.
    expect(keys.forward("up", META_LEFT)).toEqual([{ type: "up", usage: META_LEFT }]);
    expect(keys.held.size).toBe(0);
  });

  test("a modifier released during the tap is not pressed again", () => {
    const keys = createSimKeyState();
    keys.forward("down", META_LEFT);
    keys.reloadEvents();
    // Cmd goes up between the R down and up; the sim already has it up.
    expect(keys.forward("up", META_LEFT)).toEqual([]);
    expect(keys.restoreEvents()).toEqual([]);
    expect(keys.held.size).toBe(0);
  });

  test("a modifier pressed again during the tap is not pressed twice", () => {
    const keys = createSimKeyState();
    keys.forward("down", META_LEFT);
    keys.reloadEvents();
    keys.forward("up", META_LEFT);
    expect(keys.forward("down", META_LEFT)).toEqual([{ type: "down", usage: META_LEFT }]);
    expect(keys.restoreEvents()).toEqual([]);
    expect([...keys.held]).toEqual([META_LEFT]);
  });

  test("releaseAll during the tap cancels the restore", () => {
    const keys = createSimKeyState();
    keys.forward("down", META_LEFT);
    keys.reloadEvents();
    keys.releaseAll();
    expect(keys.restoreEvents()).toEqual([]);
  });

  test("reloadEvents with nothing held is a bare tap", () => {
    const keys = createSimKeyState();
    expect(keys.reloadEvents()).toEqual({ release: [], tap: HID_KEY_R });
    expect(keys.restoreEvents()).toEqual([]);
  });
});
