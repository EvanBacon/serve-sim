import { describe, expect, test, beforeEach } from "bun:test";
import {
  clearEventLogForTests,
  EVENT_LOG_MAX_ENTRIES,
  eventLogEventForCommand,
  eventLogEventForHidMessage,
  readEventLog,
  recordEventLogEvent,
  subscribeEventLog,
  updateEventLogEvent,
} from "../event-log";

beforeEach(() => {
  clearEventLogForTests();
});

describe("event log store", () => {
  test("records entries in order and filters by device", () => {
    recordEventLogEvent({
      device: "DEVICE-A",
      source: "hid",
      kind: "button",
      action: "home",
      summary: "Home",
    });
    recordEventLogEvent({
      device: "DEVICE-B",
      source: "hid",
      kind: "button",
      action: "volume-up",
      summary: "Button volume-up",
    });

    expect(readEventLog().map((event) => event.id)).toEqual([1, 2]);
    expect(readEventLog().map((event) => event.msg)).toEqual(["Home", "Button volume-up"]);
    expect(readEventLog({ device: "DEVICE-B" }).map((event) => event.summary)).toEqual([
      "Button volume-up",
    ]);
  });

  test("keeps a bunyan-style msg field on recorded entries", () => {
    recordEventLogEvent({
      source: "exec",
      kind: "button",
      action: "home",
      summary: "Home",
    });
    recordEventLogEvent({
      source: "exec",
      kind: "button",
      action: "home",
      summary: "Home",
      msg: "Pressed Home",
    });

    expect(readEventLog()).toMatchObject([
      { summary: "Home", msg: "Home" },
      { summary: "Home", msg: "Pressed Home" },
    ]);
  });

  test("supports since and limit reads", () => {
    for (let i = 0; i < 5; i++) {
      recordEventLogEvent({
        source: "exec",
        kind: "button",
        summary: `Event ${i}`,
      });
    }

    expect(readEventLog({ sinceId: 2 }).map((event) => event.id)).toEqual([3, 4, 5]);
    expect(readEventLog({ limit: 2 }).map((event) => event.id)).toEqual([4, 5]);
  });

  test("keeps only the newest entries when the store reaches its cap", () => {
    for (let i = 0; i < EVENT_LOG_MAX_ENTRIES + 3; i++) {
      recordEventLogEvent({
        source: "exec",
        kind: "button",
        summary: `Event ${i}`,
      });
    }

    const events = readEventLog();
    expect(events).toHaveLength(EVENT_LOG_MAX_ENTRIES);
    expect(events[0]).toMatchObject({ id: 4, summary: "Event 3" });
    expect(events.at(-1)).toMatchObject({
      id: EVENT_LOG_MAX_ENTRIES + 3,
      summary: `Event ${EVENT_LOG_MAX_ENTRIES + 2}`,
    });
  });

  test("notifies subscribers as entries are recorded", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeEventLog((event) => seen.push(event.summary));
    recordEventLogEvent({ source: "exec", kind: "button", summary: "Home" });
    unsubscribe();
    recordEventLogEvent({ source: "exec", kind: "button", summary: "Ignored" });
    expect(seen).toEqual(["Home"]);
  });

  test("updates entries in place and notifies subscribers", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeEventLog((event) => seen.push(event.summary));
    const entry = recordEventLogEvent({
      source: "hid",
      kind: "touch",
      action: "begin",
      summary: "Touch begin 0.1,0.2",
    });

    updateEventLogEvent(entry.id, {
      kind: "tap",
      action: "tap",
      summary: "Tap 0.1,0.2",
    });
    unsubscribe();

    expect(readEventLog()).toMatchObject([
      { id: entry.id, kind: "tap", action: "tap", summary: "Tap 0.1,0.2", msg: "Tap 0.1,0.2" },
    ]);
    expect(seen).toEqual(["Touch begin 0.1,0.2", "Tap 0.1,0.2"]);
  });

  test("can update entries without notifying subscribers", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeEventLog((event) => seen.push(event.summary));
    const entry = recordEventLogEvent({
      source: "hid",
      kind: "drag",
      action: "drag",
      summary: "Drag 0.1,0.2 -> 0.3,0.4",
    });

    updateEventLogEvent(
      entry.id,
      {
        summary: "Drag 0.1,0.2 -> 0.5,0.6",
      },
      { notify: false },
    );
    unsubscribe();

    expect(readEventLog()).toMatchObject([
      {
        id: entry.id,
        summary: "Drag 0.1,0.2 -> 0.5,0.6",
        msg: "Drag 0.1,0.2 -> 0.5,0.6",
      },
    ]);
    expect(seen).toEqual(["Drag 0.1,0.2 -> 0.3,0.4"]);
  });
});

describe("eventLogEventForHidMessage", () => {
  test("maps button HID payloads", () => {
    expect(
      eventLogEventForHidMessage("UDID", 0x04, {
        button: "volume-up",
        page: 12,
        usage: 233,
        phase: "down",
      }),
    ).toMatchObject({
      device: "UDID",
      source: "hid",
      kind: "button",
      action: "volume-up",
      summary: "Button volume-up down",
    });
  });

  test("maps touch payloads with screen details", () => {
    expect(
      eventLogEventForHidMessage("UDID", 0x03, { type: "begin", x: 0.5, y: 0.9 }, {
        width: 390,
        height: 844,
      }),
    ).toMatchObject({
      device: "UDID",
      source: "hid",
      kind: "touch",
      action: "begin",
      summary: "Touch begin 0.5,0.9",
      details: { screen: { width: 390, height: 844 } },
    });
  });

  test("redacts printable key HID usages", () => {
    for (const usage of [23, 0x1e, 0x2d]) {
      const event = eventLogEventForHidMessage("UDID", 0x06, { type: "up", usage });
      expect(event).toMatchObject({
        device: "UDID",
        source: "hid",
        kind: "key",
        action: "up",
        summary: "Key up character",
        details: { key: "character", redacted: true },
      });
      expect("usage" in event!.details!).toBe(false);
    }
  });

  test("maps non-printable key HID usages to readable labels", () => {
    expect(
      eventLogEventForHidMessage("UDID", 0x06, { type: "down", usage: 0x28 }),
    ).toMatchObject({
      summary: "Key down Enter",
      details: { usage: 0x28, key: "Enter" },
    });
  });
});

describe("eventLogEventForCommand", () => {
  test("classifies app installs without logging upload chunks", () => {
    expect(eventLogEventForCommand("bash -c 'echo abc= | base64 -d > /tmp/app.ipa'")).toBeNull();
    expect(
      eventLogEventForCommand("xcrun simctl install DEVICE-A /tmp/MyApp.ipa", { exitCode: 0 }),
    ).toMatchObject({
      device: "DEVICE-A",
      source: "exec",
      kind: "app",
      action: "install",
      status: "ok",
      summary: "Install app",
    });
  });

  test("does not persist raw exec commands, host paths, or unknown execs", () => {
    const event = eventLogEventForCommand(
      "xcrun simctl install DEVICE-A /Users/me/Secrets/MyApp.ipa --token should-not-log",
      { exitCode: 0 },
    );

    expect(event).toMatchObject({
      summary: "Install app",
      details: { exitCode: 0 },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("/Users/me");
    expect(serialized).not.toContain("MyApp.ipa");
    expect(serialized).not.toContain("should-not-log");
    expect(serialized).not.toContain("command");
    expect(serialized).not.toContain("path");
    expect(eventLogEventForCommand("curl https://example.com?token=should-not-log")).toBeNull();
  });

  test("classifies toolbar home and screenshot commands", () => {
    expect(
      eventLogEventForCommand("xcrun simctl launch DEVICE-A com.apple.springboard", { exitCode: 0 }),
    ).toMatchObject({
      device: "DEVICE-A",
      kind: "button",
      action: "home",
      summary: "Home",
    });
    expect(
      eventLogEventForCommand("xcrun simctl io DEVICE-A screenshot ~/Desktop/shot.png", { exitCode: 1 }),
    ).toMatchObject({
      device: "DEVICE-A",
      kind: "screenshot",
      status: "error",
      summary: "Screenshot",
    });
  });

  test("classifies serve-sim commands invoked through node", () => {
    expect(
      eventLogEventForCommand("node /tmp/dist/serve-sim.js button volume-up -d DEVICE-A"),
    ).toMatchObject({
      device: "DEVICE-A",
      kind: "button",
      action: "volume-up",
      summary: "Button volume-up",
    });
  });

  test("does not log read-only camera polling commands", () => {
    expect(
      eventLogEventForCommand("node /tmp/dist/serve-sim.js camera status -d DEVICE-A", { exitCode: 0 }),
    ).toBeNull();
    expect(
      eventLogEventForCommand("node /tmp/dist/serve-sim.js camera --list-webcams", { exitCode: 0 }),
    ).toBeNull();
  });
});
