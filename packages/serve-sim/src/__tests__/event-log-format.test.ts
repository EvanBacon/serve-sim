import { describe, expect, test } from "bun:test";
import { formatEventLogLine } from "../event-log-format";
import type { EventLogEntry } from "../event-log";

function entry(overrides: Partial<EventLogEntry>): EventLogEntry {
  const summary = overrides.summary ?? "Tap 0.214,0.585";
  return {
    id: 1,
    timestamp: "2026-07-02T14:24:38.000Z",
    source: "hid",
    kind: "tap",
    msg: overrides.msg ?? summary,
    summary,
    ...overrides,
  };
}

describe("formatEventLogLine", () => {
  test("hides internal source/kind and formats tap coordinates as normalized values", () => {
    expect(
      formatEventLogLine(entry({
        device: "AC78FEE5-C665-4295-889B-F6BCB1A618D5",
        kind: "tap",
        summary: "Tap 0.214,0.585",
        details: { current: { x: 0.214, y: 0.585 } },
      }), { deviceLabel: "iPhone 17" }),
    ).toContain("iPhone 17  Tap at 0.21, 0.59");
  });

  test("formats drags as a sentence", () => {
    expect(
      formatEventLogLine(entry({
        kind: "drag",
        summary: "Drag 0.854,0.542 -> 1,0.51",
        details: {
          start: { x: 0.854, y: 0.542 },
          current: { x: 1, y: 0.51 },
          moveCount: 74,
        },
      })),
    ).toContain("Drag from 0.85, 0.54 to 1.00, 0.51");
  });

  test("humanizes key and rotation labels", () => {
    expect(
      formatEventLogLine(entry({
        kind: "key",
        action: "up",
        summary: "Key up MetaLeft",
        details: { key: "MetaLeft" },
      })),
    ).toContain("Key up Left Command");
    expect(
      formatEventLogLine(entry({
        kind: "rotate",
        action: "landscape_left",
        summary: "Rotate landscape_left",
      })),
    ).toContain("Rotate landscape left");
  });
});
