import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  clangArchArgs,
  parseServeSimArch,
  swiftArchArgs,
} from "../serve-sim-arch";

const PKG = join(import.meta.dir, "../..");
const ARCH_SH = join(PKG, "scripts/serve-sim-arch.sh");
const BUILD_SCRIPTS = [
  "Sources/SimCameraInjector/build.sh",
  "Sources/SimCameraHelper/build.sh",
  "Sources/SimAXSettings/build.sh",
  "Sources/SimNative/build.sh",
] as const;

function bashArch(mode: "clang" | "swift" | "resolved", envArch?: string): string[] {
  const env = { ...process.env, SERVE_SIM_ARCH: envArch } as NodeJS.ProcessEnv;
  if (envArch === undefined) delete env.SERVE_SIM_ARCH;
  const out = execFileSync("bash", [ARCH_SH, mode], {
    encoding: "utf-8",
    env,
  }).trim();
  return out.length === 0 ? [] : out.split("\n");
}

describe("parseServeSimArch", () => {
  test("defaults to universal when unset or empty", () => {
    expect(parseServeSimArch(undefined)).toBe("universal");
    expect(parseServeSimArch("")).toBe("universal");
  });

  test("accepts arm64, x86_64, and universal", () => {
    expect(parseServeSimArch("arm64")).toBe("arm64");
    expect(parseServeSimArch("x86_64")).toBe("x86_64");
    expect(parseServeSimArch("universal")).toBe("universal");
  });

  test("rejects unknown values", () => {
    expect(() => parseServeSimArch("amd64")).toThrow(/SERVE_SIM_ARCH/);
    expect(() => parseServeSimArch("arm64 x86_64")).toThrow(/SERVE_SIM_ARCH/);
  });
});

describe("arch flag expansion", () => {
  test("CI arm64 is single-arch; default publish is fat", () => {
    expect(clangArchArgs("arm64")).toEqual(["-arch", "arm64"]);
    expect(clangArchArgs("universal")).toEqual(["-arch", "arm64", "-arch", "x86_64"]);
    expect(swiftArchArgs("arm64")).toEqual(["--arch", "arm64"]);
    expect(swiftArchArgs("universal")).toEqual(["--arch", "arm64", "--arch", "x86_64"]);
  });

  test("bash helper matches the TS flags", () => {
    for (const arch of ["arm64", "x86_64", "universal"] as const) {
      expect(bashArch("resolved", arch)).toEqual([arch]);
      expect(bashArch("clang", arch)).toEqual(clangArchArgs(arch));
      expect(bashArch("swift", arch)).toEqual(swiftArchArgs(arch));
    }
    expect(bashArch("resolved")).toEqual(["universal"]);
    expect(bashArch("clang")).toEqual(clangArchArgs("universal"));
  });

  test("bash helper rejects junk SERVE_SIM_ARCH", () => {
    expect(() => bashArch("clang", "riscv")).toThrow();
  });
});

describe("native build.sh wiring", () => {
  test("every native build script sources serve-sim-arch.sh and uses the flag arrays", () => {
    for (const rel of BUILD_SCRIPTS) {
      const text = readFileSync(join(PKG, rel), "utf-8");
      expect(text).toContain("scripts/serve-sim-arch.sh");
      expect(text).toContain("serve_sim_resolve_arch");
      if (rel.includes("SimNative")) {
        expect(text).toContain("${SERVE_SIM_SWIFT_ARCH_FLAGS[@]}");
        expect(text).not.toMatch(/-arch arm64 -arch x86_64/);
      } else {
        expect(text).toContain("${SERVE_SIM_CLANG_ARCH_FLAGS[@]}");
        expect(text).not.toMatch(/-arch arm64 -arch x86_64/);
      }
    }
  });

  test("arch helper exists", () => {
    expect(existsSync(ARCH_SH)).toBe(true);
  });
});
