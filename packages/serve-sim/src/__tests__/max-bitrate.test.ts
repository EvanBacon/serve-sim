import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import {
  MAX_BITRATE_ENV,
  applyMaxBitrateOption,
  maxBitrateFromEnv,
  parseMaxBitrateMbps,
} from "../max-bitrate";

// `--max-bitrate <Mbps>` / SERVE_SIM_MAX_BITRATE cap the resolution-scaled
// H.264 bitrate. The CLI hands the value to the in-process capture (and to a
// --detach child) through the environment; the native encoder gets bits/s.

describe("parseMaxBitrateMbps", () => {
  test("accepts integer and fractional Mbps", () => {
    expect(parseMaxBitrateMbps("8")).toBe(8);
    expect(parseMaxBitrateMbps(" 2.5 ")).toBe(2.5);
  });

  test("rejects non-positive, non-numeric, and absurd values", () => {
    for (const bad of ["", "0", "-4", "abc", "8mbps", "NaN", "Infinity", "1001"]) {
      expect(() => parseMaxBitrateMbps(bad)).toThrow();
    }
  });
});

describe("maxBitrateFromEnv", () => {
  test("is undefined when unset so the default bitrate is unchanged", () => {
    expect(maxBitrateFromEnv({})).toBeUndefined();
    expect(maxBitrateFromEnv({ [MAX_BITRATE_ENV]: "" })).toBeUndefined();
  });

  test("converts Mbps to bits per second", () => {
    expect(maxBitrateFromEnv({ [MAX_BITRATE_ENV]: "8" })).toBe(8_000_000);
    expect(maxBitrateFromEnv({ [MAX_BITRATE_ENV]: "2.5" })).toBe(2_500_000);
  });

  test("ignores an invalid value with a warning instead of failing capture", () => {
    const warnings: string[] = [];
    expect(maxBitrateFromEnv({ [MAX_BITRATE_ENV]: "fast" }, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings.join("\n")).toContain(MAX_BITRATE_ENV);
  });
});

describe("applyMaxBitrateOption", () => {
  test("the CLI flag overrides the environment", () => {
    const env: NodeJS.ProcessEnv = { [MAX_BITRATE_ENV]: "20" };
    applyMaxBitrateOption(4, env);
    expect(maxBitrateFromEnv(env)).toBe(4_000_000);
  });

  test("leaves the environment alone when the flag is absent", () => {
    const env: NodeJS.ProcessEnv = { [MAX_BITRATE_ENV]: "20" };
    applyMaxBitrateOption(undefined, env);
    expect(env[MAX_BITRATE_ENV]).toBe("20");
  });
});

describe("serve-sim --max-bitrate", () => {
  const cli = join(import.meta.dir, "..", "index.ts");

  test("is documented in --help", () => {
    const result = spawnSync("bun", [cli, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--max-bitrate <Mbps>");
    expect(result.stdout).toContain(MAX_BITRATE_ENV);
  });

  test("rejects an invalid value before starting anything", () => {
    const result = spawnSync("bun", [cli, "--max-bitrate", "zero", "--list"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--max-bitrate");
  });
});
