import { expect, test } from "bun:test";
import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { delimiter, join } from "path";

const udid = "00000000-0000-4000-8000-000000000102";
function delay(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started >= timeoutMs) throw new Error("Watchdog fixture did not reach its barrier");
    await delay(20);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const closed = Promise.withResolvers<void>();
  server.close((error) => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  return address.port;
}

// The real CLI subprocess's watchdog cannot use the test process's fake clock.
test.skipIf(process.platform === "win32")("serves HTTP while the shutdown boot-state query is pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "serve-sim-shutdown-watch-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const started = join(root, "query-started");
  const finished = join(root, "query-finished");
  const release = join(root, "release-query");
  const fixture = join(root, "xcrun.ts");
  writeFileSync(fixture, `
import { existsSync, writeFileSync } from "fs";
const args = process.argv.slice(2).join(" ");
const devices = { devices: { test: [{ udid: ${JSON.stringify(udid)}, state: "Booted" }] } };
if (args === "simctl list devices booted -j") {
  writeFileSync(${JSON.stringify(started)}, "started");
  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(20);
  writeFileSync(${JSON.stringify(finished)}, "finished");
} else if (args !== "simctl list devices -j") {
  throw new Error("Refusing unexpected simulator command: " + args);
}
console.log(JSON.stringify(devices));
`);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(bin, "xcrun"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(bin, "open"), "#!/bin/sh\nexit 88\n", { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, TMPDIR: root, TMP: root, TEMP: root };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SERVE_SIM_") || ["NODE_OPTIONS", "NODE_PATH", "DEBUG"].includes(key)) delete env[key];
  }
  const port = await freePort();
  const child = spawn(process.execPath, [join(import.meta.dir, "../index.ts"), udid,
    "--port", String(port), "--host", "127.0.0.1", "--exit-on-simulator-shutdown"], {
    env, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (data) => { stderr += data; });
  let exited = false;
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
  child.once("close", () => { exited = true; resolveClosed(); });
  child.once("error", () => { exited = true; resolveClosed(); });
  const waitClosed = async (ms: number) => {
    const timeout = Promise.withResolvers<void>();
    const timer = setTimeout(timeout.resolve, ms);
    try {
      await Promise.race([closed, timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const stateFile = join(root, "serve-sim", `server-${udid}.json`);
    await waitFor(() => {
      if (exited) throw new Error("CLI exited before readiness: " + stderr);
      return existsSync(stateFile);
    }, 10_000);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.pid).toBe(child.pid);
    expect(state.port).toBe(port);
    await waitFor(() => {
      if (exited) throw new Error("CLI exited before its boot query: " + stderr);
      return existsSync(started);
    }, 10_000);
    expect(existsSync(finished)).toBe(false);
    const response = await fetch(`http://127.0.0.1:${port}/__shutdown_watch_probe__`, { signal: AbortSignal.timeout(1_500) });
    await response.arrayBuffer();
    expect(response.status).toBe(404);
    expect(existsSync(finished)).toBe(false);
  } finally {
    writeFileSync(release, "release");
    try {
      if (existsSync(started) && !exited) await waitFor(() => existsSync(finished), 3_500);
    } finally {
      if (!exited) child.kill("SIGTERM");
      await waitClosed(2_000);
      if (!exited) child.kill("SIGKILL");
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 20_000);
