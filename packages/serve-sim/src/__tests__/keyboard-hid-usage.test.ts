import { describe, expect, test } from "bun:test";
import { HID_USAGE_BY_CODE, hidUsageForCode } from "../client/utils/hid";
import { isModifierUsage } from "../keyboard-modifiers";
import { textToKeyEvents } from "../text-to-keys";

// Regression guard for keyboard encoding. The browser viewer
// (KeyboardEvent.code → usage) and `serve-sim type` (text → usage) are two
// independent tables that must agree on USB HID Usage Page 0x07, and
// `isModifierUsage` decides which usages are released on Cmd-up and on
// session close. Pin the physical-key contract between them.

/** The usage `serve-sim type` presses for one character, minus any Shift wrap. */
function typedUsage(char: string): { usage: number; shift: boolean } {
  const downs = textToKeyEvents(char).filter((e) => e.type === "down").map((e) => e.usage);
  const shift = downs.length === 2 && downs[0] === HID_USAGE_BY_CODE.ShiftLeft;
  return { usage: downs.at(-1)!, shift };
}

describe("browser key codes and typed text agree on HID usages", () => {
  test("letters, digits, and the US punctuation row map to the same physical key", () => {
    const pairs: Array<[string, string, string?]> = [];
    for (let i = 0; i < 26; i++) {
      const lower = String.fromCharCode(0x61 + i);
      pairs.push([`Key${lower.toUpperCase()}`, lower, lower.toUpperCase()]);
    }
    const shiftedDigits = "!@#$%^&*()";
    for (const [i, d] of [..."1234567890"].entries()) pairs.push([`Digit${d}`, d, shiftedDigits[i]]);
    pairs.push(
      ["Minus", "-", "_"], ["Equal", "=", "+"], ["BracketLeft", "[", "{"], ["BracketRight", "]", "}"],
      ["Backslash", "\\", "|"], ["Semicolon", ";", ":"], ["Quote", "'", '"'], ["Backquote", "`", "~"],
      ["Comma", ",", "<"], ["Period", ".", ">"], ["Slash", "/", "?"],
      ["Space", " "], ["Enter", "\n"], ["Tab", "\t"],
    );
    for (const [code, plain, shifted] of pairs) {
      const usage = hidUsageForCode(code);
      expect({ code, usage }).toEqual({ code, usage: expect.any(Number) });
      expect({ code, typed: typedUsage(plain) }).toEqual({ code, typed: { usage: usage!, shift: false } });
      if (shifted) expect({ code, typed: typedUsage(shifted) }).toEqual({ code, typed: { usage: usage!, shift: true } });
    }
  });

  test("anchor usages from the HID spec stay put", () => {
    expect(hidUsageForCode("KeyA")).toBe(0x04);
    expect(hidUsageForCode("KeyZ")).toBe(0x1d);
    expect(hidUsageForCode("Digit1")).toBe(0x1e);
    expect(hidUsageForCode("Digit0")).toBe(0x27);
    expect(hidUsageForCode("Enter")).toBe(0x28);
    expect(hidUsageForCode("Escape")).toBe(0x29);
    expect(hidUsageForCode("Backspace")).toBe(0x2a);
    expect(hidUsageForCode("ArrowRight")).toBe(0x4f);
    expect(hidUsageForCode("ArrowUp")).toBe(0x52);
    expect(hidUsageForCode("F1")).toBe(0x3a);
    expect(hidUsageForCode("F12")).toBe(0x45);
    // Non-US/unknown codes are not guessed.
    expect(hidUsageForCode("IntlBackslash")).toBeNull();
    expect(hidUsageForCode("")).toBeNull();
  });

  test("the eight modifier keys are exactly the modifier usages", () => {
    expect({
      ControlLeft: hidUsageForCode("ControlLeft"), ShiftLeft: hidUsageForCode("ShiftLeft"),
      AltLeft: hidUsageForCode("AltLeft"), MetaLeft: hidUsageForCode("MetaLeft"),
      ControlRight: hidUsageForCode("ControlRight"), ShiftRight: hidUsageForCode("ShiftRight"),
      AltRight: hidUsageForCode("AltRight"), MetaRight: hidUsageForCode("MetaRight"),
    }).toEqual({
      ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
      ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7,
    });
    const modifierCodes = Object.entries(HID_USAGE_BY_CODE)
      .filter(([, usage]) => isModifierUsage(usage))
      .map(([code]) => code)
      .sort();
    expect(modifierCodes).toEqual([
      "AltLeft", "AltRight", "ControlLeft", "ControlRight", "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight",
    ]);
    // `serve-sim type` wraps capitals with the same Shift the browser sends.
    expect(textToKeyEvents("A")[0]).toEqual({ type: "down", usage: HID_USAGE_BY_CODE.ShiftLeft! });
  });

  test("isModifierUsage rejects neighbours and non-integers", () => {
    expect(isModifierUsage(0xdf)).toBe(false);
    expect(isModifierUsage(0xe8)).toBe(false);
    expect(isModifierUsage(0xe0 + 0.5)).toBe(false);
    expect(isModifierUsage(Number.NaN)).toBe(false);
  });

  test("every browser code maps to a distinct usage", () => {
    const usages = Object.values(HID_USAGE_BY_CODE);
    expect(new Set(usages).size).toBe(usages.length);
  });
});
