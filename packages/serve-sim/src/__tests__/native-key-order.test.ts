import { expect, test } from "bun:test";
import { NativeHid, type KeyType } from "../native";

type KeyHandle = {
  key(type: KeyType, usage: number): Promise<void>;
  close(): Promise<void>;
};

// Exercise the production wrapper without loading a macOS addon or a simulator.
function fakeHid(handle: KeyHandle): NativeHid {
  return Object.assign(Object.create(NativeHid.prototype), {
    handle,
    keyQueue: Promise.resolve(),
    heldModifiers: new Set<number>(),
    closing: false,
  }) as NativeHid;
}

function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  return { promise, finish: () => finish() };
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

test("delayed native key-down cannot finish after its release", async () => {
  const gate = deferred();
  const starts: KeyType[] = [];
  let shiftHeld = false;
  const hid = fakeHid({
    key: async (type) => {
      starts.push(type);
      if (type === "down") await gate.promise;
      shiftHeld = type === "down";
    },
    close: async () => {},
  });
  const pressed = hid.key("down", 225);
  const released = hid.key("up", 225);
  await tick();
  const beforeCompletion = [...starts];
  gate.finish();
  await Promise.all([pressed, released]);
  expect(beforeCompletion).toEqual(["down"]);
  expect(starts).toEqual(["down", "up"]);
  expect(shiftHeld).toBe(false);
});

test("a rejected native key does not block the following release", async () => {
  const calls: KeyType[] = [];
  const hid = fakeHid({
    key: async (type) => {
      calls.push(type);
      if (type === "down") throw new Error("synthetic native failure");
    },
    close: async () => {},
  });
  await Promise.all([hid.key("down", 225), hid.key("up", 225)]);
  expect(calls).toEqual(["down", "up"]);
});

test("closing waits until an already queued modifier release finishes", async () => {
  const gate = deferred();
  let shiftHeld = false;
  let heldAtClose: boolean | undefined;
  const hid = fakeHid({
    key: async (type) => {
      if (type === "up") await gate.promise;
      shiftHeld = type === "down";
    },
    close: async () => { heldAtClose = shiftHeld; },
  });
  await hid.key("down", 225);
  const released = hid.key("up", 225);
  const closed = hid.close();
  await tick();
  const closedEarly = heldAtClose !== undefined;
  gate.finish();
  await Promise.all([released, closed]);
  expect(closedEarly).toBe(false);
  expect(heldAtClose).toBe(false);
});

test("closing releases only modifiers held by this handle when no up arrived", async () => {
  const calls: string[] = [];
  const held = new Set<number>();
  const hid = fakeHid({
    key: async (type, usage) => {
      calls.push(`${type}:${usage}`);
      if (type === "down") held.add(usage);
      else held.delete(usage);
    },
    close: async () => { calls.push("close"); },
  });
  await hid.key("down", 225);
  await hid.key("down", 230);
  await hid.key("down", 4);
  await hid.close();
  expect(calls).toEqual(["down:225", "down:230", "down:4", "up:225", "up:230", "close"]);
  expect(held.has(225)).toBe(false);
  expect(held.has(230)).toBe(false);
});

test("closing retries a failed modifier release before destroying the handle", async () => {
  let releaseCalls = 0;
  let shiftHeld = false;
  let heldAtClose: boolean | undefined;
  const hid = fakeHid({
    key: async (type) => {
      if (type === "up" && ++releaseCalls === 1) throw new Error("synthetic release failure");
      shiftHeld = type === "down";
    },
    close: async () => { heldAtClose = shiftHeld; },
  });
  await hid.key("down", 225);
  await hid.key("up", 225);
  await hid.close();
  expect(releaseCalls).toBe(2);
  expect(heldAtClose).toBe(false);
});

test("keys arriving after close starts cannot hold a new modifier", async () => {
  const calls: string[] = [];
  const hid = fakeHid({
    key: async (type, usage) => { calls.push(`${type}:${usage}`); },
    close: async () => { calls.push("close"); },
  });
  await hid.key("down", 225);
  const closed = hid.close();
  await hid.key("down", 226);
  await closed;
  expect(calls).toEqual(["down:225", "up:225", "close"]);
});

test("closing releases a modifier even if down posted before rejecting", async () => {
  let shiftHeld = false;
  const hid = fakeHid({
    key: async (type) => {
      shiftHeld = type === "down";
      if (type === "down") throw new Error("synthetic failure after posting");
    },
    close: async () => { expect(shiftHeld).toBe(false); },
  });
  await hid.key("down", 225);
  await hid.close();
  expect(shiftHeld).toBe(false);
});

test("a successfully released modifier is not released again on close", async () => {
  const calls: string[] = [];
  const hid = fakeHid({
    key: async (type, usage) => { calls.push(`${type}:${usage}`); },
    close: async () => { calls.push("close"); },
  });
  await hid.key("down", 225);
  await hid.key("up", 225);
  await hid.close();
  expect(calls).toEqual(["down:225", "up:225", "close"]);
});
