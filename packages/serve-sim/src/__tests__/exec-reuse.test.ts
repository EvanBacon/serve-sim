import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setTimeout as delay } from "timers/promises";
import {
  authTokenFingerprint,
  parseDeviceState,
  reuseAuthMismatch,
  reuseExecMismatch,
} from "../helper-lifecycle";
import {
  EXEC_TOKEN_DIR,
  execTokenFileForPort,
  inProcessServeSimState,
  readExecTokenFile,
  removeExecTokenFile,
  writeExecTokenFile,
  type ServeSimDeviceState,
} from "../state";
import { freePort, waitFor } from "./server-test-support";

const UDID = "11111111-2222-3333-4444-555555555555";

describe("--detach / follow reuse checks the auth-token fingerprint", () => {
  const stateFor = (token?: string) => ({
    ...inProcessServeSimState(UDID, 3200),
    ...(token ? { authTokenSha256: authTokenFingerprint(token) } : {}),
  });

  test("the fingerprint is sha256 hex, never the raw token", () => {
    const fp = authTokenFingerprint("s3cret")!;
    expect(fp).toBe(createHash("sha256").update("s3cret").digest("hex"));
    expect(fp).not.toContain("s3cret");
    expect(authTokenFingerprint(undefined)).toBeUndefined();
  });

  test("the fingerprint survives the state-file round trip", () => {
    const parsed = parseDeviceState(JSON.stringify(stateFor("s3cret")));
    expect(parsed?.authTokenSha256).toBe(authTokenFingerprint("s3cret"));
  });

  test("same token (or none on both sides) may reuse", () => {
    expect(reuseAuthMismatch(stateFor("s3cret"), "s3cret")).toBeNull();
    expect(reuseAuthMismatch(stateFor(), undefined)).toBeNull();
  });

  test("a different token is refused with a kill hint", () => {
    const message = reuseAuthMismatch(stateFor("old-token"), "new-token");
    expect(message).toContain("different --auth-token");
    expect(message).toContain(`serve-sim -k ${UDID}`);
  });

  test("a server without a token is not reused when one is requested", () => {
    const message = reuseAuthMismatch(stateFor(), "new-token");
    expect(message).toContain("without an --auth-token");
    expect(message).toContain(`serve-sim -k ${UDID}`);
  });

  test("a token-guarded server is not reused when none is requested", () => {
    expect(reuseAuthMismatch(stateFor("old-token"), undefined)).toContain(`serve-sim -k ${UDID}`);
  });
});

describe("--detach / follow reuse checks the --allow-exec opt-in", () => {
  const stateFor = (allowExec?: boolean) => ({
    ...inProcessServeSimState(UDID, 3200),
    ...(allowExec ? { allowExec: true } : {}),
  });

  test("the opt-in survives the state-file round trip", () => {
    expect(parseDeviceState(JSON.stringify(stateFor(true)))?.allowExec).toBe(true);
    expect(parseDeviceState(JSON.stringify(stateFor()))?.allowExec).toBeUndefined();
  });

  test("a matching opt-in (on/on, off/off) may reuse", () => {
    expect(reuseExecMismatch(stateFor(true), true)).toBeNull();
    expect(reuseExecMismatch(stateFor(), false)).toBeNull();
  });

  test("an exec-enabled server is not reused when exec was not requested", () => {
    const message = reuseExecMismatch(stateFor(true), false);
    expect(message).toContain("was started with --allow-exec");
    expect(message).toContain(`serve-sim -k ${UDID}`);
  });

  test("an exec-disabled server is not reused when --allow-exec was requested", () => {
    const message = reuseExecMismatch(stateFor(), true);
    expect(message).toContain("was started without --allow-exec");
    expect(message).toContain(`serve-sim -k ${UDID}`);
  });
});

describe("serve-sim exec command line", () => {
  test("with several arguments, metacharacters in each stay literal", async () => {
    const { execCommandLine } = await import("../shell-quote");
    const { execFileSync } = await import("child_process");
    const argv = ["printf", "%s|", "a b", "$(echo injected)", "it's", "; echo nope"];
    const out = execFileSync("sh", ["-c", execCommandLine(argv)], { encoding: "utf-8" });
    expect(out).toBe("a b|$(echo injected)|it's|; echo nope|");
  });

  test("a single argument is a shell command line, passed through unquoted", async () => {
    const { execCommandLine } = await import("../shell-quote");
    const { execFileSync } = await import("child_process");
    expect(execCommandLine(["xcrun simctl list"])).toBe("xcrun simctl list");
    const out = execFileSync("sh", ["-c", execCommandLine(["printf '%s' a b | tr a-z A-Z"])], { encoding: "utf-8" });
    expect(out).toBe("AB");
  });
});

describe("exec token file", () => {
  // A port nothing in the suite binds, so a real server's file isn't touched.
  const PORT = 65_431;
  afterAll(() => removeExecTokenFile(PORT));

  test("is owner-only (dir 0700, file 0600) and round-trips", () => {
    const file = writeExecTokenFile(PORT, "file-token");
    expect(file).toBe(execTokenFileForPort(PORT));
    expect(statSync(EXEC_TOKEN_DIR).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readExecTokenFile(PORT)).toBe("file-token");
    removeExecTokenFile(PORT);
    expect(readExecTokenFile(PORT)).toBeNull();
  });
});

test.skipIf(process.platform === "win32")("follow reuses a live replacement registered during its boot query", async () => {
  const udid = "00000000-0000-4000-8000-000000000103";
  const root = mkdtempSync(join(tmpdir(), "serve-sim-reuse-"));
  const bin = join(root, "bin");
  const stateDir = join(root, "serve-sim");
  const stateFile = join(stateDir, `server-${udid}.json`);
  const release = join(root, "release-query");
  const children: { child: ChildProcess; closed: Promise<void> }[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin, TMPDIR: root, TMP: root, TEMP: root };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SERVE_SIM_") || ["NODE_OPTIONS", "NODE_PATH", "DEBUG"].includes(key)) delete env[key];
  }
  env.SERVE_SIM_TEST_QUERY_DIR = root;
  env.SERVE_SIM_TEST_UDID = udid;

  const launch = (args: string[]) => {
    // Follow's fallback helper inherits this private group, even before it writes state.
    const child = spawn(process.execPath, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
    const output: {
      child: ChildProcess;
      stdout: string;
      stderr: string;
      exited: boolean;
      error: Error | null;
    } = { child, stdout: "", stderr: "", exited: false, error: null };
    child.stdout?.on("data", (data) => { output.stdout += data; });
    child.stderr?.on("data", (data) => { output.stderr += data; });
    child.once("error", (error) => { output.error = error; });
    child.once("close", () => { output.exited = true; resolveClosed(); });
    children.push({ child, closed });
    return output;
  };
  const startListener = async () => {
    const listener = launch(["--eval", `
      const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch: () => new Response("owned reuse helper"),
      });
      console.log(JSON.stringify({ pid: process.pid, port: server.port }));
    `]);
    await waitFor(() => {
      if (listener.error || listener.exited) throw new Error("Listener failed: " + (listener.error ?? listener.stderr));
      return listener.stdout.includes("\n");
    }, 5_000, 20);
    const { pid, port } = JSON.parse(listener.stdout);
    expect(pid).toBe(listener.child.pid);
    return { ...inProcessServeSimState(udid, port), pid };
  };
  const readRecord = () => {
    try { return parseDeviceState(readFileSync(stateFile, "utf8")); } catch { return null; }
  };

  try {
    mkdirSync(bin, { mode: 0o700 });
    mkdirSync(stateDir, { mode: 0o700 });
    const xcrun = join(bin, "xcrun");
    copyFileSync(join(import.meta.dir, "fixtures/shutdown-watch-xcrun.sh"), xcrun);
    chmodSync(xcrun, 0o700);
    symlinkSync("/bin/sleep", join(bin, "sleep"));
    writeFileSync(join(bin, "open"), "#!/bin/sh\nexit 88\n", { mode: 0o700 });

    const original = await startListener();
    const replacement = await startListener();
    writeFileSync(stateFile, JSON.stringify(original), { mode: 0o600 });
    const caller = launch([join(import.meta.dir, "../index.ts"), udid,
      "--no-preview", "--quiet", "--port", String(await freePort())]);
    await waitFor(() => {
      if (caller.error || caller.exited) throw new Error("Follow exited before its boot query: " + (caller.error ?? caller.stderr));
      return existsSync(join(root, "query-started"));
    }, 10_000, 20);
    expect(existsSync(join(root, "query-finished"))).toBe(false);
    expect(readRecord()).toEqual(original);

    const nextStateFile = `${stateFile}.replacement`;
    writeFileSync(nextStateFile, JSON.stringify(replacement), { mode: 0o600 });
    renameSync(nextStateFile, stateFile);
    writeFileSync(release, "release");

    await waitFor(() => {
      if (caller.error) throw caller.error;
      const current = readRecord();
      return caller.stdout.includes("\n") || caller.exited ||
        !current || current.pid !== replacement.pid || current.port !== replacement.port;
    }, 10_000, 20);
    // A rejected replacement must not be cleared or overwritten by a new helper.
    expect(readRecord()).toEqual(replacement);
    await waitFor(() => caller.exited, 5_000, 20);
    expect(caller.child.exitCode).toBe(0);
    expect(JSON.parse(caller.stdout)).toEqual({
      url: replacement.url,
      streamUrl: replacement.streamUrl,
      wsUrl: replacement.wsUrl,
      port: replacement.port,
      device: udid,
    });
    expect(caller.stdout).not.toContain(`:${original.port}`);
    expect(caller.stdout).not.toContain(original.url);
    expect(readRecord()).toEqual(replacement);
    const response = await fetch(replacement.url, { signal: AbortSignal.timeout(1_500) });
    expect(await response.text()).toBe("owned reuse helper");
    expect(response.status).toBe(200);
  } finally {
    try {
      writeFileSync(release, "release");
      const signalGroups = (signal: NodeJS.Signals) => {
        for (const { child } of children) {
          if (!child.pid) continue;
          try { process.kill(-child.pid, signal); } catch (error: unknown) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
          }
        }
      };
      const closed = Promise.all(children.map(({ closed }) => closed));
      signalGroups("SIGTERM");
      await Promise.race([closed, delay(1_000, undefined, { ref: false })]);
      // The caller may have exited before an unwanted fallback helper did.
      signalGroups("SIGKILL");
      await Promise.race([closed, delay(2_000, undefined, { ref: false }).then(() => {
        throw new Error("Owned reuse subprocesses did not close");
      })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 45_000);

type ReuseCliProcess = {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exited: boolean;
  error: Error | null;
  closed: Promise<void>;
};

function reuseConfirmationHarness(udid: string, snapshots: (readonly string[] | null)[]) {
  const root = mkdtempSync(join(tmpdir(), "serve-sim-confirm-reuse-"));
  const bin = join(root, "bin");
  const stateDir = join(root, "serve-sim");
  const children: ReuseCliProcess[] = [];
  const stateFile = (device = udid) => join(stateDir, `server-${device}.json`);
  const startupLog = (device = udid) => join(stateDir, `server-${device}.log`);
  const queryDir = (query: number) => join(root, `query-${query}`);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin, TMPDIR: root, TMP: root, TEMP: root };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SERVE_SIM_") || ["NODE_OPTIONS", "NODE_PATH", "DEBUG"].includes(key)) delete env[key];
  }
  env.SERVE_SIM_TEST_QUERY_DIR = root;
  env.SERVE_SIM_TEST_UDID = udid;

  try {
    mkdirSync(bin, { mode: 0o700 });
    mkdirSync(stateDir, { mode: 0o700 });
    const fixture = join(root, "xcrun-fixture");
    copyFileSync(join(import.meta.dir, "fixtures/shutdown-watch-xcrun.sh"), fixture);
    chmodSync(fixture, 0o700);
    for (const [index, snapshot] of snapshots.entries()) {
      const dir = queryDir(index + 1);
      mkdirSync(dir, { mode: 0o700 });
      if (snapshot !== null) {
        writeFileSync(join(dir, "response.json"), JSON.stringify({
          devices: snapshot.length ? { test: snapshot.map((device) => ({ udid: device, state: "Booted" })) } : {},
        }), { mode: 0o600 });
      }
    }
    // Only this private wrapper opts into sequenced snapshots. Each query still
    // uses the unchanged producer's own started/release/finished barriers.
    writeFileSync(join(bin, "xcrun"), `#!/bin/sh
set -eu
root=$SERVE_SIM_TEST_QUERY_DIR
if [ "$#" -ne 5 ] || [ "$1" != simctl ] || [ "$2" != list ] || [ "$3" != devices ] || [ "$4" != booted ] || [ "$5" != -j ]; then
  printf 'Refusing unexpected simulator command: %s\\n' "$*" >&2
  exit 88
fi
for query in ${snapshots.map((_, index) => index + 1).join(" ")}; do
  dir="$root/query-$query"
  if /bin/mkdir "$dir/claimed" 2>/dev/null; then
    export SERVE_SIM_TEST_QUERY_DIR="$dir"
    if [ -e "$dir/response.json" ]; then
      "$root/xcrun-fixture" "$@" > /dev/null
      exec /bin/cat "$dir/response.json"
    fi
    exec "$root/xcrun-fixture" "$@"
  fi
done
printf unexpected > "$root/unexpected-query"
printf 'Refusing an extra boot query\\n' >&2
exit 88
`, { mode: 0o700 });
    symlinkSync("/bin/sleep", join(bin, "sleep"));
    writeFileSync(join(bin, "open"), "#!/bin/sh\nexit 88\n", { mode: 0o700 });
    // No real xcrun, lsof, or open is reachable. A fallback child's full-device
    // lookup and boot are refused before it can reach native preview startup.
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const launch = (args: string[]) => {
    const child = spawn(process.execPath, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
    const output: ReuseCliProcess = { child, stdout: "", stderr: "", exited: false, error: null, closed };
    children.push(output);
    child.stdout?.on("data", (data) => { output.stdout += data; });
    child.stderr?.on("data", (data) => { output.stderr += data; });
    child.once("error", (error) => { output.error = error; });
    child.once("close", () => { output.exited = true; resolveClosed(); });
    return output;
  };
  const readRecord = (device = udid) => {
    try { return parseDeviceState(readFileSync(stateFile(device), "utf8")); } catch { return null; }
  };
  const publish = (record: ServeSimDeviceState) => {
    const file = stateFile(record.device);
    const next = `${file}.replacement`;
    writeFileSync(next, JSON.stringify(record), { mode: 0o600 });
    renameSync(next, file);
  };
  const queryStarted = (query: number) => existsSync(join(queryDir(query), "query-started"));
  const queryFinished = (query: number) => existsSync(join(queryDir(query), "query-finished"));
  const releaseQuery = (query: number) => writeFileSync(join(queryDir(query), "release-query"), "release");
  const hasStartup = (device = udid) => existsSync(startupLog(device));
  const waitForQuery = async (caller: ReuseCliProcess, query: number) => {
    await waitFor(() => {
      if (caller.error || caller.exited) {
        throw new Error(`Follow exited before boot query ${query}: ${caller.error ?? caller.stderr}`);
      }
      if (queryStarted(query)) return true;
      if (hasStartup()) throw new Error(`Follow entered fallback startup before boot query ${query}`);
      return false;
    }, 10_000, 20);
    expect(queryFinished(query)).toBe(false);
  };
  const waitForOutcome = async (caller: ReuseCliProcess, records: ServeSimDeviceState[]) => {
    await waitFor(() => {
      if (caller.error) throw caller.error;
      return caller.exited || caller.stdout.includes("\n") || records.some((record) => {
        const current = readRecord(record.device);
        return hasStartup(record.device) || !current || current.pid !== record.pid || current.port !== record.port;
      });
    }, 10_000, 20);
    for (const record of records) {
      expect(readRecord(record.device)).toEqual(record);
      expect(hasStartup(record.device)).toBe(false);
    }
    await waitFor(() => {
      if (caller.error) throw caller.error;
      return caller.exited;
    }, 5_000, 20);
    expect(existsSync(join(root, "unexpected-query"))).toBe(false);
  };
  const expectLive = async (record: ServeSimDeviceState) => {
    const response = await fetch(record.url, { signal: AbortSignal.timeout(1_500) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("owned reuse helper");
  };
  const expectReuse = async (caller: ReuseCliProcess, records: ServeSimDeviceState[]) => {
    await waitForOutcome(caller, records);
    expect(caller.child.exitCode).toBe(0);
    const payload = records.map(({ url, streamUrl, wsUrl, port, device }) => ({ url, streamUrl, wsUrl, port, device }));
    expect(JSON.parse(caller.stdout)).toEqual(payload.length === 1 ? payload[0] : { devices: payload });
    for (const record of records) {
      expect(readRecord(record.device)).toEqual(record);
      expect(hasStartup(record.device)).toBe(false);
      await expectLive(record);
    }
  };
  const waitForFallback = async (caller: ReuseCliProcess) => {
    await waitFor(() => {
      if (caller.error) throw caller.error;
      return hasStartup() || caller.exited || caller.stdout.includes("\n");
    }, 10_000, 20);
    expect(hasStartup()).toBe(true);
    expect(caller.stdout).toBe("");
    expect(readRecord()).toBeNull();
    expect(existsSync(join(root, "unexpected-query"))).toBe(false);
  };

  return {
    readRecord, publish, queryStarted, queryFinished, releaseQuery, hasStartup,
    waitForQuery, waitForOutcome, expectLive, expectReuse, waitForFallback,
    removeRecord: () => rmSync(stateFile()),
    follow: async (devices = [udid]) => launch([
      join(import.meta.dir, "../index.ts"), ...devices,
      "--no-preview", "--quiet", "--port", String(await freePort()),
    ]),
    startListener: async (device = udid) => {
      const listener = launch(["--eval", `
        const server = Bun.serve({
          hostname: "127.0.0.1", port: 0,
          fetch: () => new Response("owned reuse helper"),
        });
        console.log(JSON.stringify({ pid: process.pid, port: server.port }));
      `]);
      await waitFor(() => {
        if (listener.error || listener.exited) throw new Error("Listener failed: " + (listener.error ?? listener.stderr));
        return listener.stdout.includes("\n");
      }, 5_000, 20);
      const { pid, port } = JSON.parse(listener.stdout);
      expect(pid).toBe(listener.child.pid);
      return { record: { ...inProcessServeSimState(device, port), pid }, listener };
    },
    cleanup: async () => {
      const errors: unknown[] = [];
      const isGroupAlive = (pid: number) => {
        try { process.kill(-pid, 0); return true; } catch (error: unknown) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
          throw error;
        }
      };
      const signalGroups = (signal: NodeJS.Signals) => {
        for (const { child } of children) {
          if (!child.pid) continue;
          try { process.kill(-child.pid, signal); } catch (error: unknown) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") errors.push(error);
          }
        }
      };
      try {
        for (let query = 1; query <= snapshots.length; query++) {
          try { releaseQuery(query); } catch (error) { errors.push(error); }
        }
        const closed = Promise.all(children.map(({ closed }) => closed));
        signalGroups("SIGTERM");
        await Promise.race([closed, delay(1_000, undefined, { ref: false })]);
        // Signal even closed leaders: their attached fallback/query descendants
        // remain in the caller's owned group until they have also exited.
        signalGroups("SIGKILL");
        try {
          await waitFor(() => children.every(({ child, exited, error }) =>
            (exited || error !== null) && (!child.pid || !isGroupAlive(child.pid))), 2_000, 20);
        } catch (error) {
          errors.push(error);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      if (errors.length) throw new AggregateError(errors, "Owned reuse subprocess cleanup failed");
    },
  };
}

test.skipIf(process.platform === "win32")("follow preserves a replacement after a stale unbooted snapshot", async () => {
  const h = reuseConfirmationHarness("00000000-0000-4000-8000-000000000104", [[], null]);
  try {
    const original = await h.startListener();
    const replacement = await h.startListener();
    h.publish(original.record);
    const caller = await h.follow();
    await h.waitForQuery(caller, 1);
    expect(h.readRecord()).toEqual(original.record);
    h.publish(replacement.record);
    h.releaseQuery(1);
    await h.waitForQuery(caller, 2);
    expect(h.queryFinished(1)).toBe(true);
    expect(h.readRecord()).toEqual(replacement.record);
    expect(h.hasStartup()).toBe(false);
    h.releaseQuery(2);
    await h.expectReuse(caller, [replacement.record]);
    expect(caller.stdout).not.toContain(original.record.url);
    expect(caller.stdout).not.toContain(`:${original.record.port}`);
  } finally {
    await h.cleanup();
  }
}, 45_000);

test.skipIf(process.platform === "win32")("follow recycles an unchanged helper after a fresh unbooted confirmation", async () => {
  const h = reuseConfirmationHarness("00000000-0000-4000-8000-000000000105", [[], []]);
  try {
    const original = await h.startListener();
    h.publish(original.record);
    const caller = await h.follow();
    await h.waitForQuery(caller, 1);
    h.releaseQuery(1);
    await h.waitForQuery(caller, 2);
    expect(h.queryFinished(1)).toBe(true);
    expect(h.readRecord()).toEqual(original.record);
    expect(original.listener.exited).toBe(false);
    expect(h.hasStartup()).toBe(false);
    h.releaseQuery(2);
    await h.waitForFallback(caller);
    expect(h.queryFinished(2)).toBe(true);
    await waitFor(() => original.listener.exited, 5_000, 20);
    expect(caller.stdout).not.toContain(original.record.url);
    expect(caller.stdout).not.toContain(`:${original.record.port}`);
  } finally {
    await h.cleanup();
  }
}, 45_000);

test.skipIf(process.platform === "win32")("follow does not report a helper removed during its boot query", async () => {
  const h = reuseConfirmationHarness("00000000-0000-4000-8000-000000000106", [null]);
  try {
    const original = await h.startListener();
    h.publish(original.record);
    const caller = await h.follow();
    await h.waitForQuery(caller, 1);
    h.removeRecord();
    h.releaseQuery(1);
    await h.waitForFallback(caller);
    expect(h.queryFinished(1)).toBe(true);
    expect(caller.stdout).not.toContain(original.record.url);
    expect(caller.stdout).not.toContain(`:${original.record.port}`);
    await h.expectLive(original.record);
  } finally {
    await h.cleanup();
  }
}, 45_000);

test.skipIf(process.platform === "win32")("follow does not reuse a helper removed during its confirmation query", async () => {
  const udid = "00000000-0000-4000-8000-000000000110";
  const h = reuseConfirmationHarness(udid, [[], [udid]]);
  try {
    const original = await h.startListener();
    h.publish(original.record);
    const caller = await h.follow();
    await h.waitForQuery(caller, 1);
    h.releaseQuery(1);
    await h.waitForQuery(caller, 2);
    h.removeRecord();
    h.releaseQuery(2);
    await h.waitForFallback(caller);
    expect(h.queryFinished(2)).toBe(true);
    expect(caller.stdout).not.toContain(original.record.url);
    expect(caller.stdout).not.toContain(`:${original.record.port}`);
    await h.expectLive(original.record);
  } finally {
    await h.cleanup();
  }
}, 45_000);

test.skipIf(process.platform === "win32")("follow preserves the latest registration when negative confirmation overlaps another replacement", async () => {
  const h = reuseConfirmationHarness("00000000-0000-4000-8000-000000000107", [[], []]);
  try {
    const original = await h.startListener();
    const replacement = await h.startListener();
    const latest = await h.startListener();
    h.publish(original.record);
    const caller = await h.follow();
    await h.waitForQuery(caller, 1);
    h.publish(replacement.record);
    h.releaseQuery(1);
    await h.waitForQuery(caller, 2);
    expect(h.readRecord()).toEqual(replacement.record);
    expect(h.hasStartup()).toBe(false);
    h.publish(latest.record);
    h.releaseQuery(2);
    await h.waitForOutcome(caller, [latest.record]);
    expect(caller.child.exitCode).toBe(1);
    expect(caller.stderr).toMatch(/changed|replaced/i);
    expect(caller.stderr).toMatch(/retry|try again|run (?:this|the) command again/i);
    expect(caller.stdout).toBe("");
    expect(h.queryFinished(2)).toBe(true);
    expect(h.readRecord()).toEqual(latest.record);
    expect(h.hasStartup()).toBe(false);
    await h.expectLive(latest.record);
  } finally {
    await h.cleanup();
  }
}, 45_000);

test.skipIf(process.platform === "win32")("follow confirms an unchanged helper omitted from a cached booted snapshot", async () => {
  const udid = "00000000-0000-4000-8000-000000000108";
  const primerUdid = "00000000-0000-4000-8000-000000000109";
  const h = reuseConfirmationHarness(udid, [[primerUdid], null]);
  try {
    const primer = await h.startListener(primerUdid);
    const original = await h.startListener();
    h.publish(primer.record);
    h.publish(original.record);
    // Reusing the primer fills the same CLI's snapshot cache with a set that
    // omits the unchanged second candidate. Only its confirmation includes it.
    const caller = await h.follow([primerUdid, udid]);
    await h.waitForQuery(caller, 1);
    h.releaseQuery(1);
    await h.waitForQuery(caller, 2);
    expect(h.queryFinished(1)).toBe(true);
    expect(h.readRecord(primerUdid)).toEqual(primer.record);
    expect(h.readRecord()).toEqual(original.record);
    expect(h.hasStartup()).toBe(false);
    h.releaseQuery(2);
    await h.expectReuse(caller, [primer.record, original.record]);
  } finally {
    await h.cleanup();
  }
}, 45_000);
