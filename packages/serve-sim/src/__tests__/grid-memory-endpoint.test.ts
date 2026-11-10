import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";
import { freePort, waitFor } from "./server-test-support";

// The devices sidebar (open by default on wide windows) polls
// /grid/api/memory every 5 s. The handler shells out to `ps -axo rss=,args=`,
// which takes seconds on a loaded host. The preview server's event loop also
// delivers the simulator's MJPEG/AVCC frames, so a synchronous `ps` froze every
// stream for that long and the viewer's 2 s staleness watchdog flipped to
// "Connecting…" (#103). These fakes make `ps` block until the test releases it.

const UDID = "00000000-0000-4000-8000-000000000103";
let root = "";
let preview: PreviewServer | null = null;
const originalPath = process.env.PATH;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "serve-sim-grid-memory-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), `#!/bin/sh
echo run >> "${root}/ps-runs"
printf started > "${root}/ps-started"
i=0
while [ ! -e "${root}/ps-release" ] && [ $i -lt 100 ]; do sleep 0.02; i=$((i+1)); done
printf finished > "${root}/ps-finished"
echo " 524288 /Users/me/Library/Developer/CoreSimulator/Devices/${UDID}/data/launchd_sim"
`, { mode: 0o700 });
  writeFileSync(join(bin, "sysctl"), `#!/bin/sh
case "$*" in
  "-n hw.memsize") echo 17179869184 ;;
  "-n hw.pagesize") echo 16384 ;;
  *) exit 88 ;;
esac
`, { mode: 0o700 });
  writeFileSync(join(bin, "vm_stat"), `#!/bin/sh
echo "Pages free:                               1000."
echo "Pages inactive:                           2000."
echo "Pages speculative:                         500."
`, { mode: 0o700 });
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
});

afterEach(() => {
  try { writeFileSync(join(root, "ps-release"), "release"); } catch {}
  preview?.stop(true);
  preview = null;
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
});

async function startPreview(): Promise<string> {
  const port = await freePort();
  preview = await servePreview({
    port,
    middleware: simMiddleware({ basePath: "/", proxyHelpers: false }),
  });
  return `http://127.0.0.1:${port}`;
}

test.skipIf(process.platform === "win32")("serves other requests while the memory probe's ps is pending", async () => {
  const origin = await startPreview();
  const startedAt = performance.now();
  let memoryDone = false;
  const memory = fetch(`${origin}/grid/api/memory`).finally(() => { memoryDone = true; });
  await waitFor(() => existsSync(join(root, "ps-started")), 3_000, 10);

  const probe = await fetch(`${origin}/__grid_memory_probe__`, { signal: AbortSignal.timeout(5_000) });
  await probe.arrayBuffer();
  const elapsed = performance.now() - startedAt;

  // A synchronous `ps` blocks the loop until it exits or its timeout kills it
  // (seconds); an async one leaves the server free to answer right away.
  expect(elapsed).toBeLessThan(1_000);
  expect(memoryDone).toBe(false);

  writeFileSync(join(root, "ps-release"), "release");
  const res = await memory;
  expect(res.status).toBe(200);
  const report = await res.json() as Record<string, unknown>;
  expect(report.totalBytes).toBe(17179869184);
  expect(report.availableBytes).toBe(3500 * 16384);
  expect(report.runningSimulators).toBe(1);
  expect(report.perSimAvgBytes).toBe(524288 * 1024);
  expect(report.perSimSource).toBe("measured");
}, 10_000);

test.skipIf(process.platform === "win32")("concurrent memory polls share one ps run", async () => {
  const origin = await startPreview();
  const first = fetch(`${origin}/grid/api/memory`);
  await waitFor(() => existsSync(join(root, "ps-started")), 3_000, 10);
  const second = fetch(`${origin}/grid/api/memory`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(join(root, "ps-release"), "release");
  const [a, b] = await Promise.all([first, second]);
  expect(await a.json()).toEqual(await b.json());
  expect(readFileSync(join(root, "ps-runs"), "utf8").trim().split("\n")).toHaveLength(1);
}, 10_000);
