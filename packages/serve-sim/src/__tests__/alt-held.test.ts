import { expect, test } from "bun:test";
import { bindAltHeld } from "../client/utils/bind-alt-held";

function event(type: string, altKey = false) {
  return Object.assign(new Event(type), { altKey });
}

test("Alt stays held through other keys and resets on release or focus loss", () => {
  const target = new EventTarget();
  let held = false;
  const dispose = bindAltHeld(target, (value) => { held = value; });
  target.dispatchEvent(event("keydown", true));
  expect(held).toBe(true);
  target.dispatchEvent(event("keyup", true));
  expect(held).toBe(true);
  target.dispatchEvent(event("keyup"));
  expect(held).toBe(false);
  target.dispatchEvent(event("pointermove", true));
  expect(held).toBe(true);
  target.dispatchEvent(new Event("blur"));
  expect(held).toBe(false);
  dispose();
  target.dispatchEvent(event("keydown", true));
  expect(held).toBe(false);
});
