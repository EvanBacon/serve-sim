import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { getPreferredDeviceUdid } from "../middleware";
import { waitFor } from "./server-test-support";

// /grid/api reads Simulator.app's CurrentDeviceUDID on most polls (the grid
// polls every 0.75–3 s; the value is cached for 1.5 s). It used to be an
// execSync, which blocked the event loop that also delivers MJPEG/AVCC frames
// for as long as `defaults` took. This fake `defaults` blocks until released.

const UDID = "00000000-0000-4000-8000-000000001114";
let root = "";
const originalPath = process.env.PATH;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "serve-sim-preferred-device-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "defaults"), `#!/bin/sh
[ "$*" = "read com.apple.iphonesimulator CurrentDeviceUDID" ] || exit 87
printf started > "${root}/started"
printf x >> "${root}/spawns"
i=0
while [ ! -e "${root}/release" ] && [ $i -lt 100 ]; do sleep 0.02; i=$((i+1)); done
[ -e "${root}/fail" ] && exit 1
echo "${UDID}"
`, { mode: 0o700 });
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")("reads the preferred device without blocking the event loop", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  let settled = false;
  const pending = getPreferredDeviceUdid().finally(() => { settled = true; });
  await waitFor(() => existsSync(join(root, "started")), 3_000, 10);
  const before = ticks;
  await new Promise((resolve) => setTimeout(resolve, 100));
  // A synchronous spawn would starve the timer until `defaults` exited.
  expect(ticks - before).toBeGreaterThan(3);
  expect(settled).toBe(false);
  writeFileSync(join(root, "release"), "release");
  expect(await pending).toBe(UDID);
  clearInterval(timer);
}, 10_000);

test.skipIf(process.platform === "win32")("caches briefly, then reports null when defaults fails", async () => {
  // Populate the cache here so this test doesn't depend on the previous one.
  rmSync(join(root, "fail"), { force: true });
  writeFileSync(join(root, "release"), "release");
  expect(await getPreferredDeviceUdid()).toBe(UDID);

  // Within the 1.5 s window the cached value is returned without a spawn.
  rmSync(join(root, "started"), { force: true });
  expect(await getPreferredDeviceUdid()).toBe(UDID);
  expect(existsSync(join(root, "started"))).toBe(false);

  await new Promise((resolve) => setTimeout(resolve, 1_600));
  writeFileSync(join(root, "fail"), "fail");
  expect(await getPreferredDeviceUdid()).toBeNull();
}, 10_000);

test.skipIf(process.platform === "win32")("overlapping lookups share one defaults process", async () => {
  rmSync(join(root, "fail"), { force: true });
  writeFileSync(join(root, "release"), "release");
  // Let any snapshot left by an earlier test expire.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  rmSync(join(root, "spawns"), { force: true });
  const [a, b] = await Promise.all([getPreferredDeviceUdid(), getPreferredDeviceUdid()]);
  expect(a).toBe(UDID);
  expect(b).toBe(UDID);
  expect(readFileSync(join(root, "spawns"), "utf-8")).toBe("x");
}, 10_000);
