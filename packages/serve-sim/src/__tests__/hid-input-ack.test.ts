import { describe, expect, test } from "bun:test";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";
import { deviceHubInputShadowedMessage } from "../device-hub-input";

// #136: `serve-sim tap/button/gesture` exited 0 even when the HID injector
// could not deliver the event (injector not set up, device gone, unknown
// button). The CLI now tags its frames with an `ack` id and the session answers
// with [0x84]{ ack, ok } once the native send settles. Frames without `ack`
// (the browser viewer) must get no reply so the viewer protocol is unchanged.

const ACK_TAG = 0x84;

type Hid = DeviceSessionDependencies["hid"];

function session(hid: Partial<Hid>, readDeviceHubInputShadowed: () => Promise<boolean | null> = async () => null, now?: () => number): {
  send: (tag: number, payload: unknown) => void;
  replies: Array<{ tag: number; body: Record<string, unknown> }>;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const base: Hid = {
    touch: async (...args) => { calls.push(["touch", ...args]); return true; },
    multiTouch: async (...args) => { calls.push(["multiTouch", ...args]); return true; },
    button: async (...args) => { calls.push(["button", ...args]); return true; },
    buttonHid: async (...args) => { calls.push(["buttonHid", ...args]); return true; },
    key: async (...args) => { calls.push(["key", ...args]); },
    scroll: async (...args) => { calls.push(["scroll", ...args]); },
    digitalCrown: async (...args) => { calls.push(["digitalCrown", ...args]); },
    orientation: async () => false,
    memoryWarning: async () => {},
    softwareKeyboard: async () => {},
    caDebug: async () => false,
    hardwareKeyboard: async () => false,
    pose: async () => false,
    hinge: async () => false,
  };
  const s = new DeviceSession("ACK-UDID", {
    capture: {
      start: async () => {},
      stop: async () => {},
      subscribeMjpeg: async () => () => {},
      subscribeAvcc: async () => () => {},
      subscribeSize: async () => () => {},
      snapshotJpeg: async () => null,
      setPreferredScreenSize: async () => {},
    },
    hid: { ...base, ...hid },
    readDeviceHubInputShadowed,
    ...(now ? { now } : {}),
  });
  const replies: Array<{ tag: number; body: Record<string, unknown> }> = [];
  let receive!: (data: Buffer) => void;
  s.attachHidSocket({
    send(frame: Buffer) {
      // Ignore config/projection seeds; only collect input acks.
      if (frame[0] === ACK_TAG) replies.push({ tag: frame[0]!, body: JSON.parse(frame.subarray(1).toString()) });
    },
    close() {},
    on(event: string, cb: (data: Buffer) => void) { if (event === "message") receive = cb; },
  } as never);
  return {
    send: (tag, payload) => receive(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))])),
    replies,
    calls,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("HID input acknowledgements (#136)", () => {
  test("a touch the injector delivered is acked ok", async () => {
    const s = session({});
    s.send(0x03, { type: "begin", x: 0.5, y: 0.5, ack: 1 });
    await settle();
    expect(s.replies).toEqual([{ tag: ACK_TAG, body: { ack: 1, ok: true } }]);
  });

  test("a touch the injector could not deliver is acked not-ok", async () => {
    const s = session({ touch: async () => false });
    s.send(0x03, { type: "begin", x: 0.5, y: 0.5, ack: 7 });
    await settle();
    expect(s.replies).toEqual([{ tag: ACK_TAG, body: { ack: 7, ok: false } }]);
  });

  test("a button the injector could not deliver is acked not-ok", async () => {
    const s = session({ button: async () => false });
    s.send(0x04, { button: "lock", ack: 3 });
    await settle();
    expect(s.replies).toEqual([{ tag: ACK_TAG, body: { ack: 3, ok: false } }]);
  });

  test("an arbitrary HID button reports the native result", async () => {
    const s = session({ buttonHid: async () => false });
    s.send(0x04, { button: "volume-up", page: 12, usage: 233, ack: 4 });
    await settle();
    expect(s.replies).toEqual([{ tag: ACK_TAG, body: { ack: 4, ok: false } }]);
  });

  test("a native throw is acked not-ok instead of escaping", async () => {
    const s = session({ touch: async () => { throw new Error("Device not found"); } });
    s.send(0x03, { type: "end", x: 0.5, y: 0.5, ack: 9 });
    await settle();
    expect(s.replies).toEqual([{ tag: ACK_TAG, body: { ack: 9, ok: false } }]);
  });

  test("frames without an ack id (browser viewer) get no reply", async () => {
    const s = session({ touch: async () => false, button: async () => false });
    s.send(0x03, { type: "begin", x: 0.5, y: 0.5 });
    s.send(0x04, { button: "home" });
    s.send(0x06, { type: "down", usage: 4 });
    s.send(0x0b, { dx: 0, dy: 0.1 });
    await settle();
    expect(s.replies).toEqual([]);
  });

  test("a failed home press while shadowed is acked not-ok without a repair-input error", async () => {
    const s = session({ button: async () => false }, async () => true);
    s.send(0x04, { button: "home", ack: 8 });
    await settle();
    expect(s.replies).toEqual([{ tag: ACK_TAG, body: { ack: 8, ok: false } }]);
  });

  test("a multitouch the injector could not deliver is acked not-ok", async () => {
    const s = session({ multiTouch: async () => false });
    s.send(0x05, { type: "begin", x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.8, ack: 9 });
    await settle();
    expect(s.replies).toEqual([{ tag: ACK_TAG, body: { ack: 9, ok: false } }]);
  });

  test("a key the injector could not deliver is acked not-ok and is not treated as forwarded typing", async () => {
    const s = session({ key: async () => false });
    s.send(0x06, { type: "down", usage: 4, ack: 10 });
    await settle();
    expect(s.replies).toEqual([{ tag: ACK_TAG, body: { ack: 10, ok: false } }]);
  });

  test("the ack id is not forwarded to the injector", async () => {
    const s = session({});
    s.send(0x04, { button: "lock", ack: 2 });
    s.send(0x03, { type: "begin", x: 0.25, y: 0.75, ack: 5 });
    await settle();
    expect(s.calls[0]).toEqual(["button", "lock"]);
    expect(s.calls[1]!.slice(0, 4)).toEqual(["touch", "begin", 0.25, 0.75]);
  });

  test("a touch is not acked as delivered when Device Hub has shadowed legacy input", async () => {
    const s = session({}, async () => true);
    s.send(0x03, { type: "begin", x: 0.5, y: 0.5, ack: 1 });
    await settle();
    expect(s.calls).toEqual([]);
    expect(s.replies).toEqual([{
      tag: ACK_TAG,
      body: { ack: 1, ok: false, error: deviceHubInputShadowedMessage("ACK-UDID") },
    }]);
  });

  test("SpringBoard home is still sent when Device Hub has shadowed legacy input", async () => {
    const s = session({}, async () => true);
    s.send(0x04, { button: "home", ack: 2 });
    await settle();
    expect(s.calls).toEqual([["button", "home"]]);
    expect(s.replies).toEqual([{ tag: ACK_TAG, body: { ack: 2, ok: true } }]);
  });

  test("lock and HID usage buttons are refused when Device Hub has shadowed legacy input", async () => {
    const s = session({}, async () => true);
    s.send(0x04, { button: "lock", ack: 1 });
    s.send(0x04, { button: "volume-up", page: 12, usage: 233, ack: 2 });
    await settle();
    expect(s.calls).toEqual([]);
    const error = deviceHubInputShadowedMessage("ACK-UDID");
    expect(s.replies).toEqual([
      { tag: ACK_TAG, body: { ack: 1, ok: false, error } },
      { tag: ACK_TAG, body: { ack: 2, ok: false, error } },
    ]);
  });

  test("key, scroll, and multitouch are refused when Device Hub has shadowed legacy input", async () => {
    const s = session({}, async () => true);
    s.send(0x06, { type: "down", usage: 4, ack: 1 });
    s.send(0x0b, { dx: 0, dy: 0.1, ack: 2 });
    s.send(0x05, { type: "begin", x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.6, ack: 3 });
    await settle();
    expect(s.calls).toEqual([]);
    const error = deviceHubInputShadowedMessage("ACK-UDID");
    expect(s.replies.map((r) => r.body)).toEqual([
      { ack: 1, ok: false, error },
      { ack: 2, ok: false, error },
      { ack: 3, ok: false, error },
    ]);
  });

  test("a burst of frames shares one shadow probe and is injected in send order", async () => {
    let probes = 0;
    const s = session({}, async () => {
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return false;
    });
    s.send(0x03, { type: "begin", x: 0.1, y: 0.1, ack: 1 });
    s.send(0x03, { type: "move", x: 0.2, y: 0.2, ack: 2 });
    s.send(0x03, { type: "move", x: 0.3, y: 0.3, ack: 3 });
    s.send(0x03, { type: "move", x: 0.4, y: 0.4, ack: 4 });
    s.send(0x03, { type: "end", x: 0.5, y: 0.5, ack: 5 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(probes).toBe(1);
    expect(s.calls.map((call) => [call[1], call[2]])).toEqual([
      ["begin", 0.1],
      ["move", 0.2],
      ["move", 0.3],
      ["move", 0.4],
      ["end", 0.5],
    ]);
    expect(s.replies.map((r) => r.body)).toEqual([
      { ack: 1, ok: true },
      { ack: 2, ok: true },
      { ack: 3, ok: true },
      { ack: 4, ok: true },
      { ack: 5, ok: true },
    ]);
  });

  test("a mid-session repair is picked up on the next event after the TTL refresh settles", async () => {
    let now = 0;
    let shadowed: boolean | null = true;
    let probes = 0;
    const s = session({}, async () => {
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return shadowed;
    }, () => now);
    s.send(0x03, { type: "begin", x: 0.5, y: 0.5, ack: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.replies[0]!.body.ok).toBe(false);
    expect(s.calls).toEqual([]);
    shadowed = false;
    now = 2_000;
    s.send(0x03, { type: "begin", x: 0.5, y: 0.5, ack: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Cached true is still used; the refresh runs in the background.
    expect(s.replies[1]!.body.ok).toBe(false);
    s.send(0x03, { type: "begin", x: 0.5, y: 0.5, ack: 3 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.replies[2]!.body).toEqual({ ack: 3, ok: true });
    expect(s.calls[0]!.slice(0, 4)).toEqual(["touch", "begin", 0.5, 0.5]);
    expect(probes).toBe(2);
  });

  test("a sync throw in the probe does not pin the in-flight promise, so a later TTL refresh can run", async () => {
    let now = 0;
    let probes = 0;
    let shadowed: boolean | "throw" = "throw";
    const s = session({}, () => {
      probes += 1;
      if (shadowed === "throw") throw new Error("defaults missing");
      return Promise.resolve(shadowed);
    }, () => now);
    s.send(0x03, { type: "begin", x: 0.5, y: 0.5, ack: 1 });
    await settle();
    // Unreadable first probe fails open (no prior true).
    expect(s.replies[0]!.body.ok).toBe(true);
    expect(probes).toBe(1);
    shadowed = true;
    now = 2_000;
    s.send(0x03, { type: "begin", x: 0.5, y: 0.5, ack: 2 });
    await settle();
    // Cached unreadable still fails open; the refresh runs in the background.
    expect(s.replies[1]!.body.ok).toBe(true);
    s.send(0x03, { type: "begin", x: 0.5, y: 0.5, ack: 3 });
    await settle();
    expect(s.replies[2]!.body.ok).toBe(false);
    expect(probes).toBe(2);
  });
});
