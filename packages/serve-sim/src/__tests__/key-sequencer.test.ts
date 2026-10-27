import { expect, test } from "bun:test";
import { KeySequencer, type KeyType } from "../key-sequencer";

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
  const hid = new KeySequencer({
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
  const hid = new KeySequencer({
    key: async (type) => {
      calls.push(type);
      if (type === "down") throw new Error("synthetic native failure");
    },
    close: async () => {},
  });
  const results = await Promise.allSettled([hid.key("down", 225), hid.key("up", 225)]);
  expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
  expect(calls).toEqual(["down", "up"]);
});

test("closing waits until an already queued modifier release finishes", async () => {
  const gate = deferred();
  let shiftHeld = false;
  let heldAtClose: boolean | undefined;
  const hid = new KeySequencer({
    key: async (type) => {
      if (type === "up") await gate.promise;
      shiftHeld = type === "down";
    },
    close: async () => { heldAtClose = shiftHeld; },
  });
  await hid.key("down", 225);
  const released = hid.key("up", 225);
  const closed = hid.drainAndRelease();
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
  const hid = new KeySequencer({
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
  await hid.drainAndRelease();
  expect(calls).toEqual(["down:225", "down:230", "down:4", "up:225", "up:230", "close"]);
  expect(held.has(225)).toBe(false);
  expect(held.has(230)).toBe(false);
});

test("closing retries a failed modifier release before destroying the handle", async () => {
  let releaseCalls = 0;
  let shiftHeld = false;
  let heldAtClose: boolean | undefined;
  const hid = new KeySequencer({
    key: async (type) => {
      if (type === "up" && ++releaseCalls === 1) throw new Error("synthetic release failure");
      shiftHeld = type === "down";
    },
    close: async () => { heldAtClose = shiftHeld; },
  });
  await hid.key("down", 225);
  await expect(hid.key("up", 225)).rejects.toThrow("synthetic release failure");
  await hid.drainAndRelease();
  expect(releaseCalls).toBe(2);
  expect(heldAtClose).toBe(false);
});

test("keys arriving after close starts cannot hold a new modifier", async () => {
  const calls: string[] = [];
  const hid = new KeySequencer({
    key: async (type, usage) => { calls.push(`${type}:${usage}`); },
    close: async () => { calls.push("close"); },
  });
  await hid.key("down", 225);
  const closed = hid.drainAndRelease();
  await hid.key("down", 226);
  await closed;
  expect(calls).toEqual(["down:225", "up:225", "close"]);
});

test("closing releases a modifier even if down posted before rejecting", async () => {
  let shiftHeld = false;
  const hid = new KeySequencer({
    key: async (type) => {
      shiftHeld = type === "down";
      if (type === "down") throw new Error("synthetic failure after posting");
    },
    close: async () => { expect(shiftHeld).toBe(false); },
  });
  await expect(hid.key("down", 225)).rejects.toThrow("synthetic failure after posting");
  await hid.drainAndRelease();
  expect(shiftHeld).toBe(false);
});

test("a successfully released modifier is not released again on close", async () => {
  const calls: string[] = [];
  const hid = new KeySequencer({
    key: async (type, usage) => { calls.push(`${type}:${usage}`); },
    close: async () => { calls.push("close"); },
  });
  await hid.key("down", 225);
  await hid.key("up", 225);
  await hid.drainAndRelease();
  expect(calls).toEqual(["down:225", "up:225", "close"]);
});

test("a never-settling key cannot prevent release attempts and native close", async () => {
  const calls: string[] = [];
  const hid = new KeySequencer({
    key: async (type, usage) => {
      calls.push(`${type}:${usage}`);
      if (type === "down") await new Promise<void>(() => {});
    },
    close: async () => { calls.push("close"); },
  }, 5);
  void hid.key("down", 225);
  await tick();
  await expect(hid.drainAndRelease()).rejects.toThrow("Keyboard teardown incomplete");
  expect(calls).toEqual(["down:225", "up:225", "close"]);
});

test("a down finishing after close is released again and queued input is discarded", async () => {
  const gate = deferred();
  const calls: string[] = [];
  let shiftHeld = false;
  const hid = new KeySequencer({
    key: async (type, usage) => {
      calls.push(`${type}:${usage}`);
      if (type === "down") await gate.promise;
      shiftHeld = type === "down";
    },
    close: async () => { calls.push("close"); },
  }, 5);
  const down = hid.key("down", 225);
  const queued = hid.key("down", 4);
  await tick();
  await expect(hid.drainAndRelease()).rejects.toThrow("Keyboard teardown incomplete");
  gate.finish();
  await Promise.all([down, queued]);
  expect(calls).toEqual(["down:225", "up:225", "close", "up:225"]);
  expect(shiftHeld).toBe(false);
});

test("never-settling releases are bounded and do not prevent native close", async () => {
  let releases = 0;
  let closed = false;
  const hid = new KeySequencer({
    key: async (type) => {
      if (type === "up") { releases++; await new Promise<void>(() => {}); }
    },
    close: async () => { closed = true; },
  }, 5);
  await hid.key("down", 225);
  await expect(hid.drainAndRelease()).rejects.toThrow("Keyboard teardown incomplete");
  expect(releases).toBe(2);
  expect(closed).toBe(true);
});

test("failed cleanup preserves modifier ownership for an explicit close retry", async () => {
  let releases = 0;
  let shiftHeld = false;
  const hid = new KeySequencer({
    key: async (type) => {
      if (type === "up" && ++releases <= 2) throw new Error("transient release failure");
      shiftHeld = type === "down";
    },
    close: async () => {},
  }, 5);
  await hid.key("down", 225);
  await expect(hid.drainAndRelease()).rejects.toThrow("Keyboard teardown incomplete");
  expect(shiftHeld).toBe(true);
  await hid.drainAndRelease();
  expect(shiftHeld).toBe(false);
  expect(releases).toBe(3);
});

test("a never-settling native close is bounded too", async () => {
  let attempted = false;
  const hid = new KeySequencer({
    key: async () => {},
    close: async () => { attempted = true; await new Promise<void>(() => {}); },
  }, 5);
  await expect(hid.drainAndRelease()).rejects.toThrow("Keyboard teardown incomplete");
  expect(attempted).toBe(true);
});

test("concurrent successful close calls share one teardown", async () => {
  let closes = 0;
  const hid = new KeySequencer({
    key: async () => {},
    close: async () => { closes++; },
  });
  const first = hid.drainAndRelease();
  expect(hid.drainAndRelease()).toBe(first);
  await first;
  await hid.drainAndRelease();
  expect(closes).toBe(1);
});
