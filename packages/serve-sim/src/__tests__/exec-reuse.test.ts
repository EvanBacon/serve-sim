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
