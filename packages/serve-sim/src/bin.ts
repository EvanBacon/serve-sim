#!/usr/bin/env node
/**
 * The `serve-sim` bin. Deliberately tiny: short commands are handed to the
 * persistent control process (see control-daemon.ts) so they skip loading
 * the ~1 MB CLI bundle; everything else, and every case where the control
 * process is unavailable, imports the bundle and runs in-process as before.
 */
import { fileURLToPath } from "url";
import { controlCli, dispatchViaControl, type ControlContext } from "./control-client";
import { runControlDaemonProcess } from "./control-daemon";
import {
  CONTROL_ACCEPT_ENV,
  CONTROL_DAEMON_ARG,
  CONTROL_IDLE_ENV,
  CONTROL_ROLE_ENV,
  DEFAULT_POOL_SIZE,
  controlFingerprint,
  controlPaths,
  parseAcceptMs,
  parseIdleMs,
} from "./control-protocol";
import { runControlWorker } from "./control-worker";

// A sibling file at runtime; kept out of this bundle on purpose.
const mainUrl = new URL("./serve-sim-cli.js", import.meta.url);
const binFile = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);

function context(): ControlContext {
  return {
    binFile,
    mainFile: fileURLToPath(mainUrl),
    execPath: process.execPath,
    execArgv: process.execArgv,
    env: process.env,
    // Lazy: a deleted cwd must not break commands that never dispatch.
    cwd: () => process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    acceptTimeoutMs: parseAcceptMs(process.env[CONTROL_ACCEPT_ENV]),
  };
}

if (process.env[CONTROL_ROLE_ENV] === "worker") {
  await runControlWorker(mainUrl.href);
} else if (args[0] === CONTROL_DAEMON_ARG) {
  const ctx = context();
  const paths = controlPaths(ctx);
  await runControlDaemonProcess({
    binFile,
    paths,
    fingerprint: controlFingerprint(ctx),
    idleMs: parseIdleMs(process.env[CONTROL_IDLE_ENV]),
    poolSize: DEFAULT_POOL_SIZE,
    roleEnv: CONTROL_ROLE_ENV,
  });
} else if (args[0] === "control") {
  process.exitCode = await controlCli(args.slice(1), context());
} else {
  const result = await dispatchViaControl(args, context());
  if (result.kind === "bypass") {
    await import(mainUrl.href);
  } else if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.code ?? 1;
  }
}
