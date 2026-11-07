import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { freePort, waitFor } from "./server-test-support";

const udid = "00000000-0000-4000-8000-000000000102";

// The real CLI subprocess's watchdog cannot use the test process's fake clock.
test.skipIf(process.platform === "win32")("serves HTTP while the shutdown boot-state query is pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "serve-sim-shutdown-watch-"));
  const bin = join(root, "bin");
  const started = join(root, "query-started");
  const finished = join(root, "query-finished");
  const release = join(root, "release-query");
  let child: ChildProcess | undefined;
  let stderr = "";
  let exited = false;
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
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
    mkdirSync(bin);
    const xcrun = join(bin, "xcrun");
    copyFileSync(join(import.meta.dir, "fixtures/shutdown-watch-xcrun.sh"), xcrun);
    chmodSync(xcrun, 0o700);
    writeFileSync(join(bin, "open"), "#!/bin/sh\nexit 88\n", { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, TMPDIR: root, TMP: root, TEMP: root };
    for (const key of Object.keys(env)) {
      if (key.startsWith("SERVE_SIM_") || ["NODE_OPTIONS", "NODE_PATH", "DEBUG"].includes(key)) delete env[key];
    }
    env.SERVE_SIM_TEST_QUERY_DIR = root;
    env.SERVE_SIM_TEST_UDID = udid;
    const port = await freePort();
    child = spawn(process.execPath, [join(import.meta.dir, "../index.ts"), udid,
      "--port", String(port), "--host", "127.0.0.1", "--exit-on-simulator-shutdown"], {
      env, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (data) => { stderr += data; });
    child.once("close", () => { exited = true; resolveClosed(); });
    child.once("error", () => { exited = true; resolveClosed(); });
    const stateFile = join(root, "serve-sim", `server-${udid}.json`);
    await waitFor(() => {
      if (exited) throw new Error("CLI exited before readiness: " + stderr);
      return existsSync(stateFile);
    }, 10_000, 20);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.pid).toBe(child.pid);
    expect(state.port).toBe(port);
    await waitFor(() => {
      if (exited) throw new Error("CLI exited before its boot query: " + stderr);
      return existsSync(started);
    }, 10_000, 20);
    expect(existsSync(finished)).toBe(false);
    const response = await fetch(`http://127.0.0.1:${port}/__shutdown_watch_probe__`, { signal: AbortSignal.timeout(1_500) });
    await response.arrayBuffer();
    expect(response.status).toBe(404);
    expect(existsSync(finished)).toBe(false);
  } catch (error) {
    throw new Error("CLI shutdown-watch probe failed: " + stderr, { cause: error });
  } finally {
    try {
      if (child) {
        writeFileSync(release, "release");
        if (existsSync(started) && !exited) await waitFor(() => existsSync(finished), 3_500, 20);
      }
    } finally {
      try {
        if (child) {
          if (!exited) child.kill("SIGTERM");
          await waitClosed(2_000);
          if (!exited) child.kill("SIGKILL");
          await closed;
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
}, 20_000);
