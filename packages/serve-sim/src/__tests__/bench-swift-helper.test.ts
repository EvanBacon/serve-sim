import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildSwiftHelper } from "../../scripts/bench/swift-helper";

let root: string;
let source: string;
let cacheDir: string;
let compiles: string[];
const fakeCompile = (src: string, out: string) => {
  compiles.push(src);
  writeFileSync(out, "#!/bin/sh\n");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bench-swift-helper-"));
  source = join(root, "probe.swift");
  writeFileSync(source, "print(1)\n");
  cacheDir = join(root, "cache", "serve-sim-bench");
  compiles = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cache location", () => {
  test("defaults to $XDG_CACHE_HOME/serve-sim-bench, never a fixed /tmp path", () => {
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(root, "xdg");
    try {
      const bin = buildSwiftHelper(source, { compile: fakeCompile });
      expect(bin.startsWith(join(root, "xdg", "serve-sim-bench") + "/")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });

  test("creates the cache directory 0700", () => {
    buildSwiftHelper(source, { cacheDir, compile: fakeCompile });
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
  });

  test("tightens an existing group/world-writable cache directory", () => {
    buildSwiftHelper(source, { cacheDir, compile: fakeCompile });
    chmodSync(cacheDir, 0o777);
    buildSwiftHelper(source, { cacheDir, compile: fakeCompile });
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
  });

  test("refuses a cache path that isn't a directory", () => {
    writeFileSync(join(root, "file"), "");
    expect(() => buildSwiftHelper(source, { cacheDir: join(root, "file"), compile: fakeCompile })).toThrow();
    expect(compiles).toHaveLength(0);
  });
});

describe("buildSwiftHelper", () => {
  test("compiles into the private cache, keyed by source hash", () => {
    const bin = buildSwiftHelper(source, { cacheDir, compile: fakeCompile });
    expect(bin.startsWith(cacheDir + "/")).toBe(true);
    expect(bin).toMatch(/\/probe-[0-9a-f]{16}$/);
    expect(existsSync(bin)).toBe(true);
    expect(statSync(bin).mode & 0o777).toBe(0o700);
    expect(compiles).toEqual([source]);
  });

  test("reuses the cached binary when the source is unchanged", () => {
    const a = buildSwiftHelper(source, { cacheDir, compile: fakeCompile });
    const b = buildSwiftHelper(source, { cacheDir, compile: fakeCompile });
    expect(b).toBe(a);
    expect(compiles).toHaveLength(1);
  });

  test("rebuilds under a new name when the source changes", () => {
    const a = buildSwiftHelper(source, { cacheDir, compile: fakeCompile });
    writeFileSync(source, "print(2)\n");
    const b = buildSwiftHelper(source, { cacheDir, compile: fakeCompile });
    expect(b).not.toBe(a);
    expect(compiles).toHaveLength(2);
  });

  test("rebuilds a cached binary that became group/world-writable", () => {
    const a = buildSwiftHelper(source, { cacheDir, compile: fakeCompile });
    chmodSync(a, 0o777);
    buildSwiftHelper(source, { cacheDir, compile: fakeCompile });
    expect(compiles).toHaveLength(2);
    expect(statSync(a).mode & 0o777).toBe(0o700);
  });

  test("leaves no binary behind when compilation fails", () => {
    expect(() =>
      buildSwiftHelper(source, {
        cacheDir,
        compile: (_src, out) => {
          writeFileSync(out, "partial");
          throw new Error("swiftc failed");
        },
      }),
    ).toThrow("swiftc failed");
    expect(() => buildSwiftHelper(source, { cacheDir, compile: fakeCompile })).not.toThrow();
    expect(compiles).toHaveLength(1);
  });
});
