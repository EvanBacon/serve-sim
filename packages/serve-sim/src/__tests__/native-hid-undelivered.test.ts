import { describe, expect, test } from "bun:test";
import { NativeHid, type NativeHidDeps } from "../native";

// After `simctl shutdown` the native injector reports each send as not
// delivered (it gates on SimDevice.state; see HIDDeliveryGate.swift). That
// `false` must reach the {ack, ok:false} reply untouched, so
// `serve-sim tap/button/gesture` exit non-zero right away instead of acking
// success until the detached server's shutdown watcher exits.

function fakeHid() {
  const device = { booted: true };
  class FakeSimHID {
    constructor(_udid: string, _duoHelper: string) {}
    isFoldable = async () => false;
    touch = async () => device.booted;
    multiTouch = async () => device.booted;
    button = async () => device.booted;
    buttonHid = async () => device.booted;
  }
  const deps: NativeHidDeps = {
    SimHID: FakeSimHID as unknown as NativeHidDeps["SimHID"],
    bundledDuoHelper: () => "/nonexistent/serve-sim-duo-hid",
    duoHelper: () => "/nonexistent/serve-sim-duo-hid",
  };
  return { hid: new NativeHid("UDID", deps), device };
}

describe("NativeHid reports undelivered input after the simulator shuts down", () => {
  test("touch, multi-touch, and buttons follow the native delivery result", async () => {
    const { hid, device } = fakeHid();
    const sends = () => Promise.all([
      hid.touch("begin", 0.5, 0.5, 100, 200),
      hid.multiTouch("begin", 0.4, 0.4, 0.6, 0.6, 100, 200),
      hid.button("home"),
      hid.buttonHid(12, 233),
    ]);
    expect(await sends()).toEqual([true, true, true, true]);
    device.booted = false;
    expect(await sends()).toEqual([false, false, false, false]);
  });
});
