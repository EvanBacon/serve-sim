import { describe, expect, test } from "bun:test";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";

// #136: `serve-sim tap/button/gesture` exited 0 even when the HID injector
// could not deliver the event (injector not set up, device gone, unknown
// button). The CLI now tags its frames with an `ack` id and the session answers
// with [0x84]{ ack, ok } once the native send settles. Frames without `ack`
// (the browser viewer) must get no reply so the viewer protocol is unchanged.

const ACK_TAG = 0x84;

type Hid = DeviceSessionDependencies["hid"];

function session(hid: Partial<Hid>): {
  send: (tag: number, payload: unknown) => void;
  replies: Array<{ tag: number; body: Record<string, unknown> }>;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const base: Hid = {
    touch: async (...args) => { calls.push(["touch", ...args]); return true; },
    multiTouch: async () => true,
    button: async (...args) => { calls.push(["button", ...args]); return true; },
    buttonHid: async (...args) => { calls.push(["buttonHid", ...args]); return true; },
    key: async () => {},
    scroll: async () => {},
    digitalCrown: async () => {},
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
    await settle();
    expect(s.replies).toEqual([]);
  });

  test("the ack id is not forwarded to the injector", async () => {
    const s = session({});
    s.send(0x04, { button: "lock", ack: 2 });
    s.send(0x03, { type: "begin", x: 0.25, y: 0.75, ack: 5 });
    await settle();
    expect(s.calls[0]).toEqual(["button", "lock"]);
    expect(s.calls[1]!.slice(0, 4)).toEqual(["touch", "begin", 0.25, 0.75]);
  });
});
