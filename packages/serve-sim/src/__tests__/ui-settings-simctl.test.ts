import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// `serve-sim ui` and the sidebar's appearance toggle shell out to
// `xcrun simctl ui <udid> <subcommand> [value]`. ui-settings.test covers
// argument parsing only; this pins what actually reaches xcrun: the simctl
// argv (device set first, simctl's own value spellings), the environment the
// caller's Xcode selection travels in, how simctl's output is read back, and
// that a simctl failure surfaces its stderr. A fake `xcrun` on PATH records
// every call, so no simulator or Xcode is needed.
//
// Each case runs in a fresh process: the device set is settled once per
// process from SERVE_SIM_DEVICE_SET, so this file's own process can't flip it.

const DEVICE_SET_ENV = "SERVE_SIM_DEVICE_SET";
const UDID = "11111111-2222-3333-4444-555555555555";
const uiSettings = join(import.meta.dir, "..", "ui-settings.ts");
const hostRpc = join(import.meta.dir, "..", "host-rpc.ts");

const root = mkdtempSync(join(tmpdir(), "serve-sim-ui-simctl-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const binDir = join(root, "bin");
const deviceSet = join(root, "set");
mkdirSync(binDir);
mkdirSync(deviceSet);

// Records argv + the env vars that steer xcrun/simctl, then answers like
// simctl: reads print the value on stdout, `fail-me` exits 1 with stderr.
const FAKE_XCRUN = `#!/usr/bin/env bun
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_XCRUN_LOG, JSON.stringify({
  argv,
  developerDir: process.env.DEVELOPER_DIR ?? null,
}) + "\\n");
const ui = argv.indexOf("ui");
const [udid, sub, value] = argv.slice(ui + 1);
if (udid === "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF") {
  process.stderr.write("Invalid device: " + udid + "\\n");
  process.exit(149);
}
if (value === undefined) {
  const reads = JSON.parse(process.env.FAKE_XCRUN_READS || "{}");
  process.stdout.write((reads[sub] ?? "") + "\\n");
}
`;
writeFileSync(join(binDir, "xcrun"), FAKE_XCRUN);
chmodSync(join(binDir, "xcrun"), 0o755);

type Call = { argv: string[]; developerDir: string | null };

function run(
  body: string,
  opts: { module?: string; set?: boolean; developerDir?: string; reads?: Record<string, string> } = {},
): { result: { ok: true; value: unknown } | { ok: false; error: string }; calls: Call[] } {
  const log = join(root, `calls-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(log, "");
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_XCRUN_LOG: log,
    FAKE_XCRUN_READS: JSON.stringify(opts.reads ?? {}),
  };
  delete env[DEVICE_SET_ENV];
  delete env.DEVELOPER_DIR;
  if (opts.set) env[DEVICE_SET_ENV] = deviceSet;
  if (opts.developerDir) env.DEVELOPER_DIR = opts.developerDir;
  const script =
    `const m = await import(${JSON.stringify(opts.module ?? uiSettings)});` +
    `try { console.log(JSON.stringify({ ok: true, value: await (async () => { ${body} })() })); }` +
    `catch (error) { console.log(JSON.stringify({ ok: false, error: String(error.message) })); }`;
  const child = spawnSync("bun", ["-e", script], { encoding: "utf8", env });
  if (child.status !== 0) throw new Error(child.stderr);
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
  return { result: JSON.parse(child.stdout.trim().split("\n").at(-1)!), calls };
}

const simctl = (set: boolean, ...args: string[]) =>
  set ? ["simctl", "--set", deviceSet, ...args] : ["simctl", ...args];

for (const set of [false, true]) {
  describe(set ? "in a configured device set" : "in Xcode's default device set", () => {
    test("sets pass simctl's own value spellings, toggles as enabled/disabled", () => {
      const { result, calls } = run(
        `await m.setUiOption("${UDID}", "appearance", "dark");
         await m.setUiOption("${UDID}", "text-size", "accessibility-extra-large");
         await m.setUiOption("${UDID}", "increase-contrast", "on");
         await m.setUiOption("${UDID}", "increase-contrast", "off");`,
        { set },
      );
      expect(result).toEqual({ ok: true, value: undefined });
      expect(calls.map((c) => c.argv)).toEqual([
        simctl(set, "ui", UDID, "appearance", "dark"),
        simctl(set, "ui", UDID, "content_size", "accessibility-extra-large"),
        simctl(set, "ui", UDID, "increase_contrast", "enabled"),
        simctl(set, "ui", UDID, "increase_contrast", "disabled"),
      ]);
    });

    test("reads ask simctl without a value and come back canonical", () => {
      const { result, calls } = run(
        `return [
           await m.getUiOption("${UDID}", "appearance"),
           await m.getUiOption("${UDID}", "text-size"),
           await m.getUiOption("${UDID}", "increase-contrast"),
         ];`,
        { set, reads: { appearance: "dark", content_size: "Small", increase_contrast: "enabled" } },
      );
      // simctl prints `content_size` as "Small" but other sizes lowercase.
      expect(result).toEqual({ ok: true, value: ["dark", "small", "on"] });
      expect(calls.map((c) => c.argv)).toEqual([
        simctl(set, "ui", UDID, "appearance"),
        simctl(set, "ui", UDID, "content_size"),
        simctl(set, "ui", UDID, "increase_contrast"),
      ]);
    });

    test("the sidebar's appearance toggle reads, then writes the opposite", () => {
      const { result, calls } = run(
        `const rpc = m.createHostRpcHandler({ serveSimBin: "serve-sim", isKnownDevice: async () => true });
         return await rpc({ method: "toggleAppearance", params: { udid: "${UDID}" } });`,
        { set, module: hostRpc, reads: { appearance: "dark" } },
      );
      expect(result).toEqual({ ok: true, value: { appearance: "light" } });
      expect(calls.map((c) => c.argv)).toEqual([
        simctl(set, "ui", UDID, "appearance"),
        simctl(set, "ui", UDID, "appearance", "light"),
      ]);
    });
  });
}

test("simctl runs under the caller's DEVELOPER_DIR (the Xcode it selected)", () => {
  const developerDir = "/Applications/Xcode-under-test.app/Contents/Developer";
  const { calls } = run(`await m.setUiOption("${UDID}", "appearance", "light");`, { developerDir });
  expect(calls).toEqual([{ argv: simctl(false, "ui", UDID, "appearance", "light"), developerDir }]);
  expect(run(`await m.getUiOption("${UDID}", "appearance");`).calls[0]!.developerDir).toBeNull();
});

test("a simctl failure surfaces simctl's stderr", () => {
  const bad = "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF";
  expect(run(`await m.setUiOption("${bad}", "appearance", "dark");`).result)
    .toEqual({ ok: false, error: `Invalid device: ${bad}` });
  expect(run(`return await m.getUiOption("${bad}", "increase-contrast");`).result)
    .toEqual({ ok: false, error: `Invalid device: ${bad}` });
});

test("an unknown option is refused before anything runs", () => {
  const { result, calls } = run(`await m.setUiOption("${UDID}", "no-such-option", "on");`);
  expect(result).toEqual({ ok: false, error: "unknown option: no-such-option" });
  expect(calls).toEqual([]);
});
