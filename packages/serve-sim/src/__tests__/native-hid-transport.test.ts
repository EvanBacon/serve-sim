import { describe, expect, test } from "bun:test";
import { NativeHid, type NativeHidDeps } from "../native";

// Touch/HID transport into the native injector: what NativeHid hands the
// addon, when, and in what order. Regression guard for the guest-HID settle
// gate (#136): input sent while a fresh HID client settles must be held — not
// dropped, not reordered (a reordered begin/end turns a tap into a
// long-press) — and setup failures or malformed input must not wedge it.

type Call = [string, ...unknown[]];

function fakeHid(options: { isFoldable?: () => Promise<boolean>; touch?: (...args: unknown[]) => unknown } = {}) {
  const calls: Call[] = [];
  const at: number[] = [];
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
    at.push(performance.now());
    return true;
  };
  class FakeSimHID {
    constructor(_udid: string, _duoHelper: string) {}
    isFoldable = options.isFoldable ?? (async () => false);
    touch = options.touch ?? record("touch");
    multiTouch = record("multiTouch");
    scroll = record("scroll");
    digitalCrown = record("digitalCrown");
    buttonHid = record("buttonHid");
    orientation = record("orientation");
  }
  const deps: NativeHidDeps = {
    SimHID: FakeSimHID as unknown as NativeHidDeps["SimHID"],
    bundledDuoHelper: () => "/nonexistent/serve-sim-duo-hid",
    duoHelper: () => {
      throw new Error("a non-Duo must not resolve the launchable helper");
    },
  };
  const createdAt = performance.now();
  return { hid: new NativeHid("UDID", deps), calls, at, createdAt };
}

describe("NativeHid touch transport", () => {
  test("holds input sent during the guest-HID settle and delivers it in send order", async () => {
    const { hid, calls, at, createdAt } = fakeHid();
    const sends = [
      hid.touch("begin", 0.25, 0.75, 1206, 2622),
      hid.touch("move", 0.3, 0.7, 1206, 2622),
      hid.multiTouch("move", 0.4, 0.4, 0.6, 0.6, 1206, 2622),
      hid.touch("end", 0.3, 0.7, 1206, 2622),
    ];
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Still settling: nothing reached the guest yet (it would be ignored).
    expect(calls).toEqual([]);
    expect(await Promise.all(sends)).toEqual([true, true, true, true]);
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      ["touch", "begin"],
      ["touch", "move"],
      ["multiTouch", "move"],
      ["touch", "end"],
    ]);
    expect(at[0]! - createdAt).toBeGreaterThanOrEqual(1_400);
    // The held events go out together, not spaced by another settle each.
    expect(at[3]! - at[0]!).toBeLessThan(100);
  }, 10_000);

  test("forwards coordinates and screen size verbatim once settled", async () => {
    const { hid, calls } = fakeHid();
    await hid.touch("begin", 0.1, 0.9, 1206, 2622);
    calls.length = 0;
    await hid.touch("move", 0.2, 0.8, 1206, 2622, 3);
    await hid.multiTouch("end", 0.1, 0.2, 0.3, 0.4, 1206, 2622);
    await hid.scroll(5, -12, 1206, 2622);
    await hid.scroll(1, 2, 1206, 2622, 0.25, 0.5);
    await hid.digitalCrown(-0.5);
    await hid.buttonHid(12, 233, "down");
    expect(calls).toEqual([
      ["touch", "move", 0.2, 0.8, 1206, 2622, 3],
      ["multiTouch", "end", 0.1, 0.2, 0.3, 0.4, 1206, 2622],
      // Omitted anchors become NaN, which the addon maps to screen center.
      ["scroll", 5, -12, NaN, NaN, 1206, 2622],
      ["scroll", 1, 2, 0.25, 0.5, 1206, 2622],
      ["digitalCrown", -0.5],
      ["buttonHid", 12, 233, "down"],
    ]);
    // A touch without an edge is sent as a plain (edge 0) touch.
    calls.length = 0;
    await hid.touch("end", 0.2, 0.8, 1206, 2622);
    expect(calls).toEqual([["touch", "end", 0.2, 0.8, 1206, 2622, 0]]);
  }, 10_000);

  test("rotation is not held behind the touch settle", async () => {
    const { hid, calls, at, createdAt } = fakeHid();
    expect(await hid.orientation(3)).toBe(true);
    expect(calls).toEqual([["orientation", 3]]);
    expect(at[0]! - createdAt).toBeLessThan(500);
  });

  test("a failed HID setup lets sends run right away instead of waiting out the settle", async () => {
    const { hid, calls, at, createdAt } = fakeHid({
      isFoldable: async () => { throw new Error("SimDevice lookup failed"); },
    });
    expect(await hid.touch("begin", 0.5, 0.5, 100, 200)).toBe(true);
    expect(calls).toEqual([["touch", "begin", 0.5, 0.5, 100, 200, 0]]);
    expect(at[0]! - createdAt).toBeLessThan(500);
  });

  test("a synchronous native throw reports undelivered and later input still flows", async () => {
    let throwNext = true;
    const delivered: unknown[][] = [];
    const { hid } = fakeHid({
      isFoldable: async () => { throw new Error("skip settle"); },
      touch: (...args: unknown[]) => {
        if (throwNext) {
          throwNext = false;
          throw new TypeError("Could not convert parameter 0 to type String");
        }
        delivered.push(args);
        return Promise.resolve(true);
      },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(await hid.touch(42 as unknown as "begin", 0.5, 0.5, 100, 200)).toBe(false);
    } finally {
      console.error = originalError;
    }
    expect(await hid.touch("begin", 0.5, 0.5, 100, 200)).toBe(true);
    expect(delivered).toEqual([["begin", 0.5, 0.5, 100, 200, 0]]);
  });
});
