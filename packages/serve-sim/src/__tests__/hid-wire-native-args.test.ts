import { afterEach, describe, expect, test } from "bun:test";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";
import { Orientation } from "../native";

// Regression guard for the HID WebSocket wire format: each viewer/CLI frame
// must reach the native injector with exactly these arguments. A change here
// (field renamed, size not passed, scroll left unscaled, orientation numbers
// swapped) silently mis-aims input on every simulator, so pin what is sent.

type Hid = DeviceSessionDependencies["hid"];

const W = 1206;
const H = 2622;

const sessions: DeviceSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.close();
});

async function session(overrides: Partial<Hid> = {}) {
  const calls: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return true; };
  const hid: Hid = {
    touch: record("touch"),
    multiTouch: record("multiTouch"),
    button: record("button"),
    buttonHid: record("buttonHid"),
    key: record("key"),
    scroll: record("scroll"),
    digitalCrown: record("digitalCrown"),
    orientation: record("orientation"),
    memoryWarning: async () => {},
    softwareKeyboard: async () => {},
    caDebug: async () => false,
    hardwareKeyboard: async () => false,
    pose: async () => false,
    hinge: async () => false,
    ...overrides,
  } as Hid;
  const s = new DeviceSession("WIRE-UDID", {
    capture: {
      start: async () => {},
      stop: async () => {},
      subscribeMjpeg: async () => () => {},
      subscribeAvcc: async () => () => {},
      subscribeSize: async (cb) => { void cb({ width: W, height: H }); return () => {}; },
      snapshotJpeg: async () => null,
      setPreferredScreenSize: async () => {},
    },
    hid,
    createDuoRenderer: () => ({ render: async () => { throw new Error("no renderer"); }, close: () => {} }),
    rollingBuffer: null,
    readDeviceHubInputShadowed: async () => false,
    hardwareKeyboardState: { read: () => null, write: () => {} },
    softwareKeyboardVisible: async () => null,
  });
  sessions.push(s);
  await s.start();
  let receive!: (data: Buffer) => void;
  s.attachHidSocket({
    send() {},
    close() {},
    on(event: string, cb: (data: Buffer) => void) { if (event === "message") receive = cb; },
  } as never);
  const send = (tag: number, payload: unknown) =>
    receive(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
  return { send, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("HID wire frames reach the native injector with exact arguments", () => {
  test("0x03 touch passes normalized coords, screen pixels, and edge (default 0)", async () => {
    const s = await session();
    s.send(0x03, { type: "begin", x: 0.25, y: 0.75 });
    s.send(0x03, { type: "move", x: 0, y: 1, edge: 3 });
    s.send(0x03, { type: "end", x: 1, y: 0 });
    await settle();
    expect(s.calls).toEqual([
      ["touch", "begin", 0.25, 0.75, W, H, 0],
      ["touch", "move", 0, 1, W, H, 3],
      ["touch", "end", 1, 0, W, H, 0],
    ]);
  });

  test("0x05 multi-touch keeps both fingers in x1, y1, x2, y2 order", async () => {
    const s = await session();
    s.send(0x05, { type: "begin", x1: 0.2, y1: 0.3, x2: 0.8, y2: 0.7 });
    s.send(0x05, { type: "move", x1: 0.1, y1: 0.4, x2: 0.9, y2: 0.6 });
    s.send(0x05, { type: "end", x1: 0.1, y1: 0.4, x2: 0.9, y2: 0.6 });
    await settle();
    expect(s.calls).toEqual([
      ["multiTouch", "begin", 0.2, 0.3, 0.8, 0.7, W, H],
      ["multiTouch", "move", 0.1, 0.4, 0.9, 0.6, W, H],
      ["multiTouch", "end", 0.1, 0.4, 0.9, 0.6, W, H],
    ]);
  });

  test("0x06 key forwards type and HID usage, including modifiers", async () => {
    const s = await session();
    s.send(0x06, { type: "down", usage: 0xe3 }); // Left Cmd
    s.send(0x06, { type: "down", usage: 0x19 }); // V
    s.send(0x06, { type: "up", usage: 0x19 });
    s.send(0x06, { type: "up", usage: 0xe3 });
    await settle();
    expect(s.calls).toEqual([
      ["key", "down", 0xe3],
      ["key", "down", 0x19],
      ["key", "up", 0x19],
      ["key", "up", 0xe3],
    ]);
  });

  test("0x04 named buttons go to button(); page/usage buttons go to buttonHid() with phase default press", async () => {
    const s = await session();
    s.send(0x04, { button: "home" });
    s.send(0x04, { button: "lock" });
    s.send(0x04, { button: "volume-up", page: 12, usage: 233 });
    s.send(0x04, { button: "volume-up", page: 12, usage: 233, phase: "down" });
    s.send(0x04, { button: "volume-up", page: 12, usage: 233, phase: "up" });
    await settle();
    expect(s.calls).toEqual([
      ["button", "home"],
      ["button", "lock"],
      ["buttonHid", 12, 233, "press"],
      ["buttonHid", 12, 233, "down"],
      ["buttonHid", 12, 233, "up"],
    ]);
  });

  test("0x0b scroll scales display-fraction deltas to device pixels and keeps the anchor", async () => {
    const s = await session();
    s.send(0x0b, { dx: 0.5, dy: -0.25, x: 0.5, y: 0.4 });
    s.send(0x0b, { dx: 0, dy: 0.5 });
    await settle();
    expect(s.calls).toEqual([
      ["scroll", 0.5 * W, -0.25 * H, W, H, 0.5, 0.4],
      ["scroll", 0, 0.5 * H, W, H, undefined, undefined],
    ]);
  });

  test("0x0a digital crown forwards the delta unchanged", async () => {
    const s = await session();
    s.send(0x0a, { delta: -12.5 });
    await settle();
    expect(s.calls).toEqual([["digitalCrown", -12.5]]);
  });

  test("0x07 orientation names map to the UIDeviceOrientation values the guest accepts", async () => {
    // Pinned numerically: GraphicsServices takes UIDeviceOrientation, and the
    // Swift side (HIDInjector.orientation*) hard-codes the same 1..4.
    expect(Orientation).toEqual({ portrait: 1, portraitUpsideDown: 2, landscapeRight: 3, landscapeLeft: 4 });
    const s = await session();
    for (const orientation of ["landscape_left", "landscape_right", "portrait_upside_down", "portrait"]) {
      s.send(0x07, { orientation });
      await settle();
    }
    expect(s.calls).toEqual([
      ["orientation", 4],
      ["orientation", 3],
      ["orientation", 2],
      ["orientation", 1],
    ]);
  });

  test("0x07 with an unknown orientation never reaches the injector", async () => {
    const s = await session();
    s.send(0x07, { orientation: "faceUp" });
    s.send(0x07, { orientation: "LANDSCAPE_LEFT" });
    await settle();
    expect(s.calls).toEqual([]);
  });
});
