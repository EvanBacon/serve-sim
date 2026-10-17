import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";

// `exports` points TypeScript consumers at raw `src/*.ts` files (e.g. the
// `./middleware` types entry), so every module those files import —
// transitively — has to ship in the npm tarball. Otherwise consumers get
// "Cannot find module './max-bitrate'" when type-checking against the
// published package, even though the repo checkout resolves fine.

const PKG_DIR = join(import.meta.dir, "../..");
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf-8"));

function srcEntries(): string[] {
  const entries = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (/^\.\/src\/.*\.tsx?$/.test(value)) entries.add(value.slice(2));
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(pkg.exports);
  return [...entries];
}

const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

function resolveLocal(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

function importClosure(entries: string[]): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf-8").matchAll(IMPORT_RE)) {
      const target = resolveLocal(file, m[1]!);
      if (target) visit(target);
    }
  };
  for (const entry of entries) visit(join(PKG_DIR, entry));
  return [...seen].map((f) => relative(PKG_DIR, f)).sort();
}

function isPublished(file: string): boolean {
  return (pkg.files as string[]).some((pattern) => new Bun.Glob(pattern).match(file));
}

describe("published files", () => {
  test("exports reference at least one src entry", () => {
    expect(srcEntries()).toContain("src/middleware.ts");
  });

  test("every src module reachable from an exported .ts entry is in `files`", () => {
    const missing = importClosure(srcEntries()).filter((f) => !isPublished(f));
    expect(missing).toEqual([]);
  });
});
