import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const cli = join(import.meta.dir, "../index.ts");
function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("fold help advertises degrees and removes the pose command", () => {
  const help = run("fold", "--help");
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("fold [options] <deg>");
  const old = run("pose", "book");
  expect(old.status).not.toBe(0);
  expect(run("--help").stdout).not.toContain("pose [options]");
});

test.each(["book", "closed", "open", "NaN", "Infinity", "181", "-1", " "])("fold rejects invalid angle %s before device lookup", (angle) => {
  const result = run("fold", "--", angle);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Hinge angle must be between 0 and 180 degrees.");
});
