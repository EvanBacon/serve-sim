import { describe, expect, test } from "bun:test";
import { createSimKeyState } from "../client/utils/sim-keyboard";

const META_LEFT = 0xe3;
const META_RIGHT = 0xe7;
const SHIFT_LEFT = 0xe1;
const KEY_A = 0x04;
const KEY_R = 0x15;

describe("createSimKeyState", () => {
  test("forwards a plain key press and release", () => {
    const keys = createSimKeyState();
    expect(keys.forward("down", KEY_R)).toEqual([{ type: "down", usage: KEY_R }]);
    expect(keys.forward("up", KEY_R)).toEqual([{ type: "up", usage: KEY_R }]);
    expect(keys.held.size).toBe(0);
  });

  test("releasing Cmd also releases the R that Cmd+R left held", () => {
    // macOS browsers never fire keyup for R in Cmd+R; if the sim keeps R
    // held, the toolbar Reload's R tap is swallowed.
    const keys = createSimKeyState();
    keys.forward("down", META_LEFT);
    keys.forward("down", KEY_R);
    expect(keys.forward("up", META_LEFT)).toEqual([
      { type: "up", usage: KEY_R },
      { type: "up", usage: META_LEFT },
    ]);
    expect(keys.held.size).toBe(0);
    // A late R keyup (non-macOS browsers do send it) isn't sent twice.
    expect(keys.forward("up", KEY_R)).toEqual([]);
    // The next R press reaches the sim as a fresh press.
    expect(keys.forward("down", KEY_R)).toEqual([{ type: "down", usage: KEY_R }]);
  });

  test("releasing Cmd keeps other modifiers held", () => {
    const keys = createSimKeyState();
    keys.forward("down", SHIFT_LEFT);
    keys.forward("down", META_RIGHT);
    keys.forward("down", KEY_A);
    expect(keys.forward("up", META_RIGHT)).toEqual([
      { type: "up", usage: KEY_A },
      { type: "up", usage: META_RIGHT },
    ]);
    expect([...keys.held]).toEqual([SHIFT_LEFT]);
  });

  test("releasing a non-Cmd key only releases that key", () => {
    const keys = createSimKeyState();
    keys.forward("down", SHIFT_LEFT);
    keys.forward("down", KEY_A);
    expect(keys.forward("up", SHIFT_LEFT)).toEqual([{ type: "up", usage: SHIFT_LEFT }]);
    expect([...keys.held]).toEqual([KEY_A]);
  });

  test("releaseAll lifts every held key once", () => {
    const keys = createSimKeyState();
    keys.forward("down", META_LEFT);
    keys.forward("down", KEY_R);
    expect(keys.releaseAll()).toEqual([
      { type: "up", usage: META_LEFT },
      { type: "up", usage: KEY_R },
    ]);
    expect(keys.releaseAll()).toEqual([]);
    // The browser's own keyup after the release is swallowed.
    expect(keys.forward("up", META_LEFT)).toEqual([]);
  });
});
