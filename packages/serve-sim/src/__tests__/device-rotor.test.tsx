import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DeviceRotor } from "../client/components/device-rotor";

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;

describe("DeviceRotor", () => {
  let dom: Window;
  let root: Root | undefined;
  let previous: Map<string, unknown>;
  let host: HTMLElement;
  let animations: number;

  beforeEach(() => {
    dom = new Window({ url: "http://localhost/" });
    previous = new Map();
    for (const name of GLOBALS) {
      previous.set(name, (globalThis as Record<string, unknown>)[name]);
      (globalThis as Record<string, unknown>)[name] =
        name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name];
    }
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    animations = 0;
    // Stub WAAPI: count spins and keep them "running" so data-rotating sticks.
    const proto = (dom as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype;
    proto.animate = function animate() {
      animations++;
      return { cancel() {}, onfinish: null };
    };
    proto.getAnimations = () => [];
    host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    await dom.happyDOM.abort();
    for (const name of GLOBALS) {
      const prior = previous.get(name);
      if (prior === undefined) delete (globalThis as Record<string, unknown>)[name];
      else (globalThis as Record<string, unknown>)[name] = prior;
    }
  });

  async function render(props: { degrees: number; confirmed?: boolean; streamKey?: string }) {
    await act(async () => {
      root ??= createRoot(host);
      root.render(
        <DeviceRotor reducedMotion={false} {...props}>
          <div />
        </DeviceRotor>,
      );
    });
  }

  const rotor = () => host.querySelector("[data-device-rotation]") as HTMLElement;

  test("first landscape config after the portrait fallback snaps, no spin", async () => {
    // null config → fallback (portrait, unconfirmed) → real landscape push.
    await render({ degrees: 0, confirmed: false, streamKey: "a" });
    await render({ degrees: 90, confirmed: true, streamKey: "a" });
    expect(rotor().dataset.rotating).toBeUndefined();
    expect(animations).toBe(0);
  });

  test("a stream switch resets the baseline", async () => {
    await render({ degrees: 0, confirmed: true, streamKey: "a" });
    await render({ degrees: 90, confirmed: true, streamKey: "b" });
    expect(rotor().dataset.rotating).toBeUndefined();
    expect(animations).toBe(0);
  });

  test("a confirmed orientation change spins and blocks taps until done", async () => {
    await render({ degrees: 0, confirmed: true, streamKey: "a" });
    await render({ degrees: 90, confirmed: true, streamKey: "a" });
    expect(animations).toBe(1);
    expect(rotor().dataset.rotating).toBe("true");
    expect(rotor().style.pointerEvents).toBe("none");
  });
});
