import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Use a test-specific state dir to avoid conflicting with real state
const TEST_STATE_DIR = join(tmpdir(), "serve-sim-test-" + process.pid);

// We test the state module functions directly
import { stateFileForDevice, listStateFiles, STATE_DIR } from "../state";

describe("multi-device state", () => {
  const testDir = TEST_STATE_DIR;

  beforeEach(() => {
    // Create a temp dir that mimics the state dir structure
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch {}
  });

  it("stateFileForDevice returns unique paths per UDID", () => {
    const file1 = stateFileForDevice("AAAA-BBBB-CCCC");
    const file2 = stateFileForDevice("DDDD-EEEE-FFFF");
    expect(file1).not.toBe(file2);
    expect(file1).toContain("server-AAAA-BBBB-CCCC.json");
    expect(file2).toContain("server-DDDD-EEEE-FFFF.json");
  });

  it("stateFileForDevice produces path inside STATE_DIR", () => {
    const file = stateFileForDevice("TEST-UDID");
    expect(file.startsWith(STATE_DIR)).toBe(true);
  });

  it("multiple state files can coexist", () => {
    // Write state files directly to the real state dir for listStateFiles
    mkdirSync(STATE_DIR, { recursive: true });
    const udid1 = "TEST-1111-2222-3333-444444444444";
    const udid2 = "TEST-5555-6666-7777-888888888888";
    const file1 = stateFileForDevice(udid1);
    const file2 = stateFileForDevice(udid2);

    try {
      writeFileSync(file1, JSON.stringify({ pid: process.pid, port: 3100, device: udid1, url: "http://127.0.0.1:3100", streamUrl: "http://127.0.0.1:3100/stream.mjpeg", wsUrl: "ws://127.0.0.1:3100/ws" }));
      writeFileSync(file2, JSON.stringify({ pid: process.pid, port: 3101, device: udid2, url: "http://127.0.0.1:3101", streamUrl: "http://127.0.0.1:3101/stream.mjpeg", wsUrl: "ws://127.0.0.1:3101/ws" }));

      const files = listStateFiles();
      const matching = files.filter(f => f.includes("TEST-"));
      expect(matching.length).toBeGreaterThanOrEqual(2);

      // Both files contain correct data
      const data1 = JSON.parse(readFileSync(file1, "utf-8"));
      const data2 = JSON.parse(readFileSync(file2, "utf-8"));
      expect(data1.device).toBe(udid1);
      expect(data2.device).toBe(udid2);
      expect(data1.port).toBe(3100);
      expect(data2.port).toBe(3101);
    } finally {
      try { rmSync(file1); } catch {}
      try { rmSync(file2); } catch {}
    }
  });

  it("listStateFiles only returns server-*.json files", () => {
    mkdirSync(STATE_DIR, { recursive: true });
    const validFile = stateFileForDevice("TEST-VALID-UDID");
    const otherFile = join(STATE_DIR, "other-file.json");

    try {
      writeFileSync(validFile, "{}");
      writeFileSync(otherFile, "{}");

      const files = listStateFiles();
      const hasValid = files.some(f => f.includes("TEST-VALID-UDID"));
      const hasOther = files.some(f => f.includes("other-file"));
      expect(hasValid).toBe(true);
      expect(hasOther).toBe(false);
    } finally {
      try { rmSync(validFile); } catch {}
      try { rmSync(otherFile); } catch {}
    }
  });
});

