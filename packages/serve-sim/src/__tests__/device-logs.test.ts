import { describe, expect, test } from "bun:test";
import { queryLogLevel } from "../middleware";
import {
  appendLogEntryBuffer,
  filterDeviceLogs,
  matchesCurrentApp,
  normalizeLogLevel,
  parseDeviceLogEntry,
  type DeviceLogEntry,
} from "../client/utils/logs";

describe("device log parsing", () => {
  test("normalizes known log levels", () => {
    expect(normalizeLogLevel("Error")).toBe("error");
    expect(normalizeLogLevel("fault")).toBe("fault");
    expect(normalizeLogLevel("notice")).toBe("unknown");
  });

  test("parses os_log ndjson rows into table entries", () => {
    const entry = parseDeviceLogEntry({
      timestamp: "2026-05-16 12:10:11.000000-0300",
      messageType: "Info",
      processImagePath: "/Containers/Bundle/Application/App/Goodword",
      processID: 1234,
      subsystem: "com.goodword.app",
      category: "network",
      eventMessage: "Loaded profile",
    }, 7);
    expect(entry).toMatchObject({
      id: 7,
      level: "info",
      process: "Goodword",
      processKey: "goodword",
      processID: 1234,
      subsystem: "com.goodword.app",
      category: "network",
      message: "Loaded profile",
    });
  });

  test("drops rows without a message", () => {
    expect(parseDeviceLogEntry({ messageType: "Info" }, 1)).toBeNull();
  });
});

describe("device log filtering", () => {
  const entries: DeviceLogEntry[] = [
    makeEntry(1, "info", "Goodword", "profile loaded", 101, "com.goodword.app", "api"),
    makeEntry(2, "error", "SpringBoard", "launch failed", 202, "com.apple.springboard", "lifecycle"),
    makeEntry(3, "debug", "Goodword", "cache hit", 101, "com.goodword.app", "storage"),
  ];

  test("filters by level, search, and current app", () => {
    const visible = filterDeviceLogs(entries, {
      search: "PROFILE",
      levels: new Set(["info", "error", "fault", "default", "debug"]),
      process: "",
      currentAppOnly: true,
      currentApp: { bundleId: "com.goodword.app", pid: 101, executable: "Goodword" },
    });
    expect(visible.map((entry) => entry.id)).toEqual([1]);
  });

  test("matches current app by pid, executable, or bundle text", () => {
    expect(matchesCurrentApp(entries[0]!, { bundleId: "x", pid: 101 })).toBe(true);
    expect(matchesCurrentApp(entries[0]!, { bundleId: "x", executable: "Goodword" })).toBe(true);
    expect(matchesCurrentApp(makeEntry(4, "info", "Other", "com.goodword.app did work"), { bundleId: "com.goodword.app" })).toBe(true);
  });

  test("keeps the log buffer bounded", () => {
    const next = appendLogEntryBuffer(entries, makeEntry(4, "fault", "Goodword", "boom"), 3);
    expect(next.map((entry) => entry.id)).toEqual([2, 3, 4]);
  });
});

describe("queryLogLevel", () => {
  test("allows only supported simctl stream levels", () => {
    expect(queryLogLevel("/logs?level=debug")).toBe("debug");
    expect(queryLogLevel("/logs?level=default")).toBe("default");
    expect(queryLogLevel("/logs?level=fault")).toBe("info");
    expect(queryLogLevel("/logs")).toBe("info");
  });
});

function makeEntry(
  id: number,
  level: DeviceLogEntry["level"],
  process: string,
  message: string,
  processID?: number,
  subsystem = "",
  category = "",
): DeviceLogEntry {
  return {
    id,
    timestamp: "",
    level,
    process,
    processKey: process.toLowerCase(),
    processID,
    subsystem,
    category,
    message,
    searchText: [message, process, subsystem, category, level].join("\n").toLowerCase(),
    raw: { eventMessage: message },
  };
}
