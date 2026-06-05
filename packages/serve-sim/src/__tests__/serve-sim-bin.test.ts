import { describe, test, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";
import { existsSync, statSync } from "fs";

const BIN_PATH = resolve(__dirname, "../../bin/serve-sim-bin");

const isDarwin = process.platform === "darwin";
const describeIfDarwin = isDarwin ? describe : describe.skip;

describeIfDarwin("serve-sim-bin binary", () => {
  test("exists on disk", () => {
    expect(existsSync(BIN_PATH)).toBe(true);
  });

  test("is a universal Mach-O binary (arm64 + x86_64)", () => {
    const output = execSync(`file "${BIN_PATH}"`, { encoding: "utf8" });
    // Matches both the fat header line and the individual slices
    expect(output).toContain("Mach-O universal binary with 2 architectures");
    expect(output).toContain("arm64");
    expect(output).toContain("x86_64");
  });

  test("lipo reports both architectures", () => {
    const output = execSync(`lipo -info "${BIN_PATH}"`, { encoding: "utf8" });
    expect(output).toMatch(/Architectures in the fat file:.*x86_64.*arm64|arm64.*x86_64/);
  });

  test("is executable (has user execute bit)", () => {
    const stats = statSync(BIN_PATH);
    // 0o111 is any execute bit; on our shipped bins we set 0o755
    expect(stats.mode & 0o111).not.toBe(0);
  });
});
