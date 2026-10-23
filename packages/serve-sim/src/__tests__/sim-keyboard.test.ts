import { describe, expect, test } from "bun:test";
import {
  HID_KEY_R,
  createSimKeyState,
  isFormControlTarget,
  isInteractiveTarget,
  isReloadShortcut,
  keepsNativeButtonKey,
  releaseFocusToSim,
} from "../client/utils/sim-keyboard";

const META_LEFT = 0xe3;
const META_RIGHT = 0xe7;
const SHIFT_LEFT = 0xe1;
const KEY_A = 0x04;

function key(code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) {
  return { code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("isReloadShortcut", () => {
  test("matches Cmd+R only", () => {
    expect(isReloadShortcut(key("KeyR", { metaKey: true }))).toBe(true);
    expect(isReloadShortcut(key("KeyR"))).toBe(false);
    // Cmd+Shift+R and Ctrl/Alt chords are forwarded to the sim as keys.
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

  test("releasing Cmd also releases the R that Cmd+R left held", () => {
    // macOS browsers never fire keyup for R in Cmd+R; if the sim keeps R
    // held, the toolbar Reload's R tap is swallowed.
    const keys = createSimKeyState();
    keys.forward("down", META_LEFT);
    keys.forward("down", HID_KEY_R);
    expect(keys.forward("up", META_LEFT)).toEqual([
      { type: "up", usage: HID_KEY_R },
      { type: "up", usage: META_LEFT },
    ]);
    expect(keys.held.size).toBe(0);
    // A late R keyup (non-macOS browsers do send it) isn't sent twice.
    expect(keys.forward("up", HID_KEY_R)).toEqual([]);
    // The next R press reaches the sim as a fresh press.
    expect(keys.forward("down", HID_KEY_R)).toEqual([{ type: "down", usage: HID_KEY_R }]);
  });

  test("releasing Cmd keeps other held modifiers down", () => {
    const keys = createSimKeyState();
    keys.forward("down", SHIFT_LEFT);
    keys.forward("down", META_LEFT);
    expect(keys.forward("up", META_LEFT)).toEqual([{ type: "up", usage: META_LEFT }]);
    expect([...keys.held]).toEqual([SHIFT_LEFT]);
  });

  test("releasing right Cmd keeps other modifiers held", () => {
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

describe("keepsNativeButtonKey", () => {
  test("keeps button activation and focus keys native", () => {
    for (const code of ["Tab", "Enter", "NumpadEnter", "Space"]) {
      expect(keepsNativeButtonKey(code)).toBe(true);
    }
    for (const code of ["KeyR", "ArrowLeft", "Escape", "Backspace"]) {
      expect(keepsNativeButtonKey(code)).toBe(false);
    }
  });
});

describe("isFormControlTarget", () => {
  const el = (matches: boolean) => ({ closest: (sel: string) => (matches && sel.includes("input") ? {} : null) });

  test("matches targets inside input, select or textarea", () => {
    expect(isFormControlTarget(el(true) as unknown as EventTarget)).toBe(true);
    expect(isFormControlTarget(el(false) as unknown as EventTarget)).toBe(false);
  });

  test("ignores non-element targets", () => {
    expect(isFormControlTarget(null)).toBe(false);
    expect(isFormControlTarget({} as EventTarget)).toBe(false);
  });
});

describe("isInteractiveTarget", () => {
  // Minimal stand-in for Element#closest that matches a single tag name.
  const el = (tag: string | null) => ({
    closest: (sel: string) => (tag && sel.split(",").map((s) => s.trim()).includes(tag) ? {} : null),
  });

  test("matches focusable controls anywhere on the page", () => {
    for (const tag of ["button", "a[href]", "input", "select", "textarea", "[tabindex]", "[contenteditable]"]) {
      expect(isInteractiveTarget(el(tag) as unknown as EventTarget)).toBe(true);
    }
  });

  test("leaves the body and plain elements to the sim", () => {
    expect(isInteractiveTarget(el(null) as unknown as EventTarget)).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
    expect(isInteractiveTarget({} as EventTarget)).toBe(false);
  });
});

describe("releaseFocusToSim", () => {
  // A page with a sidebar button that keeps focus until something blurs it.
  function page() {
    const body = { closest: () => null };
    const button = { closest: () => ({}), blur: () => (doc.activeElement = body) };
    const doc: { activeElement: unknown; body: unknown } = { activeElement: body, body };
    return { doc, body, button };
  }

  test("control focused, then sim clicked, then Space reaches the sim", () => {
    const { doc, button } = page();
    doc.activeElement = button; // clicked a sidebar button earlier
    expect(keepsNativeButtonKey("Space") && isInteractiveTarget(doc.activeElement as EventTarget)).toBe(true);
    releaseFocusToSim(doc as unknown as Document); // pointerdown inside the sim
    // Keydown targets the active element (now the body), so Space is forwarded.
    expect(isInteractiveTarget(doc.activeElement as EventTarget)).toBe(false);
  });

  test("leaves the body alone", () => {
    const { doc, body } = page();
    releaseFocusToSim(doc as unknown as Document);
    expect(doc.activeElement).toBe(body);
    releaseFocusToSim({ activeElement: null, body } as unknown as Document);
  });
});
