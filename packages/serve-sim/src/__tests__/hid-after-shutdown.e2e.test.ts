import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

/**
 * After `simctl shutdown`, SimDeviceLegacyHIDClient keeps accepting sends, so
 * `serve-sim tap` exited 0 until the server went away. Its port also stays dead
 * after the same device boots again, so a server that stayed up (foreground,
 * not --detach) acked taps that never reached the guest. The injector now
 * drops input while the device isn't Booted and rebuilds the client when it
 * comes back.
 *
 * Opt-in because it shuts the simulator down and boots it again: set
 * SERVE_SIM_E2E_SHUTDOWN_UDID to an iOS simulator this test may restart, never a
 * shared one. CI runs it last on its own simulator (scripts/run-sim-e2e.ts).
 */

const CLI = join(import.meta.dir, "../../dist/serve-sim.js");
const udid = process.env.SERVE_SIM_E2E_SHUTDOWN_UDID;
if (udid && !existsSync(CLI)) {
  throw new Error(`SERVE_SIM_E2E_SHUTDOWN_UDID is set but ${CLI} is missing; build the CLI first`);
}
const describeIfOptedIn = udid ? describe : describe.skip;
// The serve-sim CLI reads SERVE_SIM_DEVICE_SET itself; pass the same set to the
// test's own simctl calls so the test can run against a private-set simulator.
const deviceSet = process.env.SERVE_SIM_DEVICE_SET?.trim() || undefined;
const simctl = (...args: string[]): string[] => (deviceSet ? ["simctl", "--set", deviceSet, ...args] : ["simctl", ...args]);
const RECONNECTED = "[hid] Simulator Booted again, reconnected HID client";
const NO_SERVER = "No serve-sim server running";

/** The foreground server's port, for the liveness probe in failure messages. */
let serverPort: number | undefined;

/** The device's state as simctl reports it, for failure messages. */
function deviceState(): string {
  const r = spawnSync("xcrun", simctl("list", "devices", "-j"), { encoding: "utf-8", timeout: 5_000 });
  if (r.error || r.status !== 0) return `unknown (simctl list: ${r.error ?? `status ${r.status}`})`;
  try {
    const data = JSON.parse(r.stdout) as { devices: Record<string, Array<{ udid: string; state: string }>> };
    for (const devices of Object.values(data.devices)) {
      const d = devices.find((x) => x.udid === udid);
      if (d) return d.state;
    }
  } catch {}
  return "not listed";
}

/**
 * Where things stood when a tap CLI hung: whether the server's event loop
 * still answers HTTP, and the device's state. On CI the tap CLI has been
 * killed at its timeout with no output, which this tells apart from a server
 * that stopped answering or a device still between states.
 * Capped at ~8s (curl 2s, simctl list 5s), and only collected once a caller
 * has given up retrying (withHangContext), so it never eats a retry window.
 */
function hangContext(): string {
  let http = "server port unknown";
  if (serverPort) {
    const r = spawnSync(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code} in %{time_total}s", "-m", "2", `http://127.0.0.1:${serverPort}/api`],
      { encoding: "utf-8", timeout: 3_000 },
    );
    http = r.status === 0 ? `server /api answered ${r.stdout}` : `server /api did not answer (curl exit ${r.status}, ${r.stdout})`;
  }
  return `${http}; device ${deviceState()}`;
}

/**
 * Where the guest's boot is, from a 4s `simctl bootstatus` read: its last
 * "Waiting on …" line, or that it is booted. Tells "the guest never finished
 * booting" (a slow runner: on a throttled local sim SpringBoard took 155s)
 * apart from "booted, but input still refused". Failure messages only.
 */
function guestBootPhase(): string {
  const started = Date.now();
  const r = spawnSync("xcrun", simctl("bootstatus", udid!), { encoding: "utf-8", timeout: 4_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (/already booted|Finished/i.test(out)) return `booted (bootstatus answered in ${Date.now() - started}ms)`;
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const status = lines.filter((l) => /^\[.*Status=/.test(l)).at(-1) ?? "no status line";
  const waiting = lines.filter((l) => /^Waiting on /.test(l)).at(-1) ?? "no Waiting line";
  return `still booting after a ${Date.now() - started}ms bootstatus read: ${status} ${waiting}`;
}

interface TapResult { status: number | null; stderr: string; ms: number; hung: boolean }

function tap(timeoutMs = 8_000): TapResult {
  const started = Date.now();
  // serve-sim:cli/state debug lines (timestamped on a pipe) show how far a
  // hung CLI got: state lookup, /config, WebSocket open, or the ack wait.
  const r = spawnSync("node", [CLI, "tap", "0.97", "0.03", "-d", udid!], {
    encoding: "utf-8",
    timeout: timeoutMs,
    env: { ...process.env, DEBUG: "serve-sim:cli,serve-sim:state" },
  });
  const ms = Date.now() - started;
  // No hangContext() here: it takes up to ~8s and would eat the caller's
  // retry window. Callers add it via withHangContext() once they give up.
  const detail = r.error ? `${r.error}\n[test] tap CLI killed after ${ms}ms` : "";
  const stderr = `${r.stderr ?? ""}${detail ? `\n${detail}` : ""}`;
  return { status: r.status, stderr, ms, hung: !!r.error };
}

/** `r`'s stderr, plus server/device state if the tap CLI hung. For terminal failures only. */
function withHangContext(r: TapResult): string {
  return r.hung ? `${r.stderr}\n[test] at failure: ${hangContext()}` : r.stderr;
}

/** One line per tap attempt (offset from `since`, exit status, CLI wall time). */
function timeline(attempts: ReadonlyArray<{ at: number; r: TapResult }>, since: number): string {
  const lines = attempts.map(({ at, r }) => `  +${at - since}ms status=${r.status} took=${r.ms}ms`);
  const shown = lines.length > 30 ? [`  … ${lines.length - 30} earlier`, ...lines.slice(-30)] : lines;
  return `tap attempts (${attempts.length}):\n${shown.join("\n")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Boot and wait. No `bootstatus -b`: on Xcode 27 it can stay blocked once Booted. */
function bootAndWait(): void {
  const started = Date.now();
  const boot = spawnSync("xcrun", simctl("boot", udid!), { encoding: "utf-8" });
  const booted = Date.now();
  const status = spawnSync("xcrun", simctl("bootstatus", udid!), { encoding: "utf-8", timeout: 120_000 });
  if (status.status === 0) {
    console.log(`hid e2e bootAndWait: simctl boot ${booted - started}ms, bootstatus ${Date.now() - booted}ms`);
    return;
  }
  throw new Error(
    `simctl bootstatus ${udid} failed after ${Date.now() - booted}ms ` +
      `(status ${status.status}${status.error ? `, ${status.error}` : ""}); device ${deviceState()}\n` +
      `simctl boot took ${booted - started}ms, exit ${boot.status}: ${(boot.stderr ?? "").trim()}\n` +
      `bootstatus output:\n${status.stdout ?? ""}${status.stderr ?? ""}`,
  );
}

async function tapUntilOk(timeoutMs: number): Promise<TapResult & { timeline: string }> {
  const since = Date.now();
  const deadline = since + timeoutMs;
  const attempts: Array<{ at: number; r: TapResult }> = [];
  let last = tap();
  attempts.push({ at: Date.now(), r: last });
  while (last.status !== 0 && Date.now() < deadline) {
    await sleep(500);
    last = tap();
    attempts.push({ at: Date.now(), r: last });
  }
  // Terminal failure: only now is there time to spend on hang diagnostics.
  const stderr = last.status === 0 ? last.stderr : withHangContext(last);
  return { ...last, stderr, timeline: timeline(attempts, since) };
}

describeIfOptedIn(`HID input across simctl shutdown + boot (${udid ?? "<skipped>"})`, () => {
  let server: ChildProcess | undefined;
  let serverLog = "";

  beforeAll(async () => {
    bootAndWait();
    try { execFileSync("node", [CLI, "--kill", udid!], { stdio: "pipe" }); } catch {}
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    serverPort = port;
    // Foreground (no --detach): unlike a detached helper it has no
    // --exit-on-simulator-shutdown watcher, so it stays up across the reboot.
    server = spawn("node", [CLI, udid!, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    server.stdout!.on("data", (d) => { serverLog += d; });
    server.stderr!.on("data", (d) => { serverLog += d; });
    const ready = await tapUntilOk(45_000);
    if (ready.status !== 0) throw new Error(`serve-sim server never accepted a tap: ${ready.stderr}\n${ready.timeline}\n${serverLog}`);
  }, 240_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([new Promise((r) => server!.once("exit", r)), sleep(5_000)]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    try { execFileSync("node", [CLI, "--kill", udid!], { stdio: "pipe" }); } catch {}
    // Leave the simulator booted, as the test found it.
    bootAndWait();
  }, 180_000);

  test("tap fails with an undelivered error shortly after shutdown, while the server is up", async () => {
    // A correct drop must nack (not the old 7s fire-and-forget ack). The
    // CLI wall time on a loaded macos-26 runner can be ~4s during
    // shutdown even when the injector drops immediately, so the bound is
    // 6s — still under the old 7s success window, and a hung actor fails
    // this sooner via "no delivery confirmation" (4s) instead of
    // "could not deliver".
    expect(tap().status).toBe(0);

    const shutdown = spawn("xcrun", simctl("shutdown", udid!), { stdio: "ignore" });
    const issued = Date.now();
    const shutdownExit = new Promise<number>((r) => shutdown.on("exit", () => r(Date.now())));
    let failure: { afterMs: number; stderr: string } | undefined;
    const attempts: Array<{ at: number; r: TapResult }> = [];
    while (Date.now() - issued < 6_000) {
      const r = tap();
      attempts.push({ at: Date.now(), r });
      if (r.status !== 0) { failure = { afterMs: Date.now() - issued, stderr: withHangContext(r) }; break; }
    }
    const shutdownMs = (await shutdownExit) - issued;
    const context = () => `simctl shutdown exited at +${shutdownMs}ms\n${timeline(attempts, issued)}\n${serverLog}`;

    if (!failure) throw new Error(`every tap in the 6s after \`simctl shutdown\` exited 0\n${context()}`);
    expect(failure.stderr, `first undelivered tap at ${failure.afterMs}ms\n${failure.stderr}\n${context()}`).toContain("could not deliver the tap");
    expect(failure.afterMs, `first undelivered tap at ${failure.afterMs}ms (stderr: ${failure.stderr})\n${context()}`).toBeLessThan(6_000);
    // The injector refused the tap, so the server was answering.
    expect(failure.stderr).not.toContain(NO_SERVER);
    expect(server!.exitCode).toBeNull();
    // It still answers once the device is fully down.
    const down = tap();
    expect(down.status).not.toBe(0);
    expect(down.stderr, withHangContext(down)).toContain("could not deliver the tap");
    expect(down.stderr).not.toContain(NO_SERVER);
  }, 60_000);

  test("after simctl boot, input is acked again well before the 30s not-ready limit", async () => {
    // Don't wait for bootstatus: the not-ready window used to refuse every
    // tap for a full 30s because admit() blocked transmit, so a success
    // could never clear the flag. A non-action probe every 0.5s should
    // clear that flag once the guest can take input. Guest boot itself
    // can exceed 20s on a slow CI runner, so the 20s bound is measured
    // from the first not-ready log, not from `simctl boot`.
    const NOT_READY_LOG = "[hid] Dropping input: HID client is not ready";
    const logAtStart = serverLog.length;
    let notReadyAt: number | undefined;
    // Search accumulated serverLog so a message split across `data` chunks
    // still matches. `tap()` uses spawnSync and blocks the event loop, so
    // yield after each tap to let queued stdout/stderr handlers append.
    const stampNotReady = () => {
      if (notReadyAt != null) return;
      if (serverLog.slice(logAtStart).includes(NOT_READY_LOG)) notReadyAt = Date.now();
    };
    const onData = () => { stampNotReady(); };
    stampNotReady();
    server!.stdout!.on("data", onData);
    server!.stderr!.on("data", onData);
    const bootIssued = Date.now();
    spawnSync("xcrun", simctl("boot", udid!), { stdio: "ignore" });
    const bootReturnedMs = Date.now() - bootIssued;
    let firstOkAt: number | undefined;
    let lastFail = "";
    let lastTap: TapResult | undefined;
    const attempts: Array<{ at: number; r: TapResult }> = [];
    const deadline = Date.now() + 90_000;
    try {
      while (Date.now() < deadline) {
        const r = tap();
        attempts.push({ at: Date.now(), r });
        await sleep(0);
        stampNotReady();
        if (r.status === 0) { firstOkAt = Date.now(); break; }
        lastTap = r;
        lastFail = `status=${r.status} exit=${server!.exitCode}\n${r.stderr}`;
        expect(r.stderr, lastFail).not.toContain(NO_SERVER);
        if (server!.exitCode != null) throw new Error(`serve-sim server exited ${server!.exitCode} while waiting for a post-boot tap\n${lastFail}\n${serverLog.slice(logAtStart)}`);
        await sleep(400);
      }
    } finally {
      server!.stdout!.off("data", onData);
      server!.stderr!.off("data", onData);
    }
    if (firstOkAt == null) {
      throw new Error(
        `no successful tap within 90s of simctl boot (boot returned at +${bootReturnedMs}ms; device now ${deviceState()}; ` +
          `first not-ready log ${notReadyAt == null ? "never" : `at +${notReadyAt - bootIssued}ms`}; guest ${guestBootPhase()})\n` +
          `${lastFail}${lastTap?.hung ? `\n[test] at failure: ${hangContext()}` : ""}\n${timeline(attempts, bootIssued)}\n${serverLog.slice(logAtStart)}`,
      );
    }
    console.log(
      `hid e2e post-boot: boot returned +${bootReturnedMs}ms, first not-ready log ` +
        `${notReadyAt == null ? "never" : `+${notReadyAt - bootIssued}ms`}, first ok tap +${firstOkAt - bootIssued}ms ` +
        `after ${attempts.length} taps`,
    );
    if (notReadyAt != null) {
      expect(
        firstOkAt - notReadyAt,
        `first ok tap ${firstOkAt - notReadyAt}ms after the first not-ready log\n${timeline(attempts, bootIssued)}`,
      ).toBeLessThan(20_000);
    }
    expect(server!.exitCode).toBeNull();
  }, 150_000);

  const LANDS_TIMEOUT_MS = 180_000;
  test("after the same simulator boots again, a tap on the guest lands", async () => {
    // Wrong-page diagnostics below are bounded by this so the wrong-page
    // error is always thrown before bun's test timeout replaces it.
    const diagDeadline = Date.now() + LANDS_TIMEOUT_MS - 10_000;
    const diagLeft = () => diagDeadline - Date.now();
    bootAndWait();
    const r = await tapUntilOk(30_000);
    expect(r.stderr).not.toContain(NO_SERVER);
    expect(r.status, `no successful tap within 30s of bootstatus\n${r.stderr}\n${r.timeline}\n${serverLog}`).toBe(0);
    expect(server!.exitCode).toBeNull();
    // Without the rebuild the tap above also exits 0 but never reaches the guest.
    const deadline = Date.now() + 5_000;
    while (!serverLog.includes(RECONNECTED) && Date.now() < deadline) await sleep(100);
    expect(serverLog).toContain(RECONNECTED);
    expect(serverLog.split(RECONNECTED).length - 1).toBe(1);

    // Prove the rebuilt client actually delivers: open Settings, tap General,
    // and assert the General screen (About) appears in the AX tree.
    try { execFileSync("xcrun", simctl("terminate", udid!, "com.apple.Preferences"), { stdio: "pipe" }); } catch {}
    execFileSync("xcrun", simctl("launch", udid!, "com.apple.Preferences"), { stdio: "pipe", timeout: 30_000 });

    const axText = (timeoutMs = 15_000): { status: number | null; stdout: string; stderr: string } => {
      const s = spawnSync("node", [CLI, "ax", "--refs", "--text", "-d", udid!], { encoding: "utf-8", timeout: timeoutMs });
      return { status: s.status, stdout: s.stdout ?? "", stderr: `${s.stderr ?? ""}${s.error ? `\n${s.error}` : ""}` };
    };
    // The last AX read, for a failure message: "never matched" alone doesn't
    // say whether the AX call failed or the screen showed something else.
    const describeAx = (s: { status: number | null; stdout: string; stderr: string } | undefined, reads: number) =>
      s ? `last of ${reads} ax reads: status=${s.status}\nstderr: ${s.stderr.trim()}\nstdout:\n${s.stdout}` : "no ax reads";

    let lastAx: ReturnType<typeof axText> | undefined;
    let axReads = 0;
    /**
     * Poll the AX tree until `done` matches (returns the snapshot) or `ms`
     * passes. With `bounded`, each read's timeout is also capped to the time
     * left (diagnostics only; the polls under test keep the 15s read timeout).
     */
    const waitForAx = async (done: (text: string) => boolean, ms: number, intervalMs: number, bounded = false): Promise<string | undefined> => {
      lastAx = undefined;
      axReads = 0;
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const s = axText(bounded ? Math.max(1, Math.min(15_000, deadline - Date.now())) : 15_000);
        lastAx = s;
        axReads++;
        if (s.status === 0 && done(s.stdout)) return s.stdout;
        await sleep(intervalMs);
      }
      return undefined;
    };
    // A Settings sub-page other than General: a back button to "Settings"
    // under some other heading. `tap @ref` re-resolves the ref against the
    // live tree before tapping (ax-agent.ts act()), so landing here means it
    // tapped stale coordinates: a product bug to surface, never retry past.
    const otherSettingsPage = (text: string): string | undefined => {
      if (/"About"/.test(text) || !/back button "Settings"/.test(text)) return undefined;
      const heading = text.match(/^@e\d+ heading "([^"]*)"/m)?.[1];
      return heading && heading !== "General" && heading !== "Settings" ? heading : undefined;
    };
    /** The "General" line of an `ax --refs --text` dump, and its frame in device points. */
    const generalLine = (text: string) => {
      const line = text.split("\n").find((l) => /^@e\d+\s+\S+\s+"General"/.test(l));
      const f = line?.match(/\((-?[\d.]+),(-?[\d.]+) ([\d.]+)x([\d.]+)\)\s*$/);
      return { line, frame: f ? { x: +f[1]!, y: +f[2]!, w: +f[3]!, h: +f[4]! } : undefined };
    };
    /** Lines of a dump whose frame contains point (x, y). */
    const linesAt = (text: string, x: number, y: number) =>
      text.split("\n").filter((l) => {
        const f = l.match(/\((-?[\d.]+),(-?[\d.]+) ([\d.]+)x([\d.]+)\)\s*$/);
        return !!f && x >= +f[1]! && x <= +f[1]! + +f[3]! && y >= +f[2]! && y <= +f[2]! + +f[4]!;
      });
    /**
     * The capture's content-change counter (what act() compares to skip its
     * pre-tap re-read), from `/api/diagnostics`. Two reads 1s apart show
     * whether it is advancing. Capped so a slow collection can't stall.
     */
    const frameCounters = async (): Promise<string> => {
      const read = async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${serverPort}/api/diagnostics?device=${udid}`, { signal: AbortSignal.timeout(4_000) });
          if (!res.ok) return `HTTP ${res.status}`;
          const found: Record<string, unknown> = {};
          const walk = (v: unknown) => {
            if (!v || typeof v !== "object") return;
            for (const [k, x] of Object.entries(v)) {
              if (k === "content_change_count" || k === "frame_count" || k === "last_frame_age_ms" || k === "phase") found[k] = x;
              else walk(x);
            }
          };
          walk(await res.json());
          return JSON.stringify(found);
        } catch (e) {
          return `unavailable (${e})`;
        }
      };
      const first = await read();
      await sleep(1_000);
      return `first ${first}; +1s ${await read()}`;
    };

    // The Settings root (no back button), not a page still animating away.
    const snapshot = await waitForAx((text) => /"General"/.test(text) && !/back button "Settings"/.test(text), 20_000, 500);
    if (!snapshot) throw new Error(`Settings did not show a General row after launch:\n${describeAx(lastAx, axReads)}`);
    const snapshotAt = Date.now();
    const generalRef = snapshot.match(/(@e\d+)\s+\S+\s+"General"/)?.[1];
    if (!generalRef) throw new Error(`could not find a General ref in:\n${snapshot}`);
    const tapStarted = Date.now();
    const tapped = spawnSync("node", [CLI, "tap", generalRef, "-d", udid!], { encoding: "utf-8", timeout: 15_000 });
    const tapDetail = `tap ${generalRef} (${tapStarted - snapshotAt}ms after its snapshot, took ${Date.now() - tapStarted}ms): ` +
      `status=${tapped.status}${tapped.error ? ` (${tapped.error})` : ""}\nstdout: ${tapped.stdout ?? ""}\nstderr: ${tapped.stderr ?? ""}`;
    expect(tapped.status, tapDetail).toBe(0);
    expect(tapped.stderr).not.toContain(NO_SERVER);

    const after = await waitForAx((text) => /"About"/.test(text) || otherSettingsPage(text) !== undefined, 15_000, 300);
    if (after && /"About"/.test(after)) return;
    const afterAx = describeAx(lastAx, axReads);
    const other = after ? otherSettingsPage(after) : undefined;
    if (!after || !other) {
      throw new Error(`tapping General should open the General screen (About row)\n${tapDetail}\nsnapshot the ref came from:\n${snapshot}\n${afterAx}`);
    }

    // Wrong page. Gather what tells a stale tap point apart from stale AX
    // data: General's frame then vs now, what sits at the old centre now, and
    // the frame counter. Diagnostics only; the test fails either way, and
    // each step is skipped or shortened to fit the time left before the test
    // timeout so this error is never replaced by a timeout.
    const counters = diagLeft() > 10_000 ? await frameCounters() : `skipped (${diagLeft()}ms left before the test timeout)`;
    const then = generalLine(snapshot);
    let fresh = "no fresh read (no back button on the wrong page)";
    const backRef = after.match(/(@e\d+) back button "Settings"/)?.[1];
    if (backRef && diagLeft() < 3_000) {
      fresh = `fresh root read skipped (${diagLeft()}ms left before the test timeout)`;
    } else if (backRef) {
      const back = spawnSync("node", [CLI, "tap", backRef, "-d", udid!], { encoding: "utf-8", timeout: Math.min(10_000, diagLeft() - 1_000) });
      const root = back.status === 0 && diagLeft() > 1_000
        ? await waitForAx((text) => /"General"/.test(text) && !/back button "Settings"/.test(text), Math.min(8_000, diagLeft()), 500, true)
        : undefined;
      if (!root) {
        fresh = `no fresh root read (back tap status=${back.status}${back.error ? `, ${back.error}` : ""}); ${describeAx(lastAx, axReads)}`;
      } else {
        const now = generalLine(root);
        const at = then.frame ? linesAt(root, then.frame.x + then.frame.w / 2, then.frame.y + then.frame.h / 2) : [];
        fresh = `General now: ${now.line ?? "(missing)"}\n` +
          `at the snapshot's General centre now: ${at.length ? at.join(" | ") : "(nothing)"}\n` +
          `fresh root read:\n${root}`;
      }
    }
    throw new Error(
      `tap ${generalRef} ("General") opened the "${other}" page instead of General. ` +
        `act() re-resolves refs against the live tree before tapping, so this is a stale tap point or stale AX data, not test timing.\n` +
        `General in the snapshot the ref came from: ${then.line ?? "(missing)"}\n${fresh}\n` +
        `content-change counter (/api/diagnostics): ${counters}\n${tapDetail}\n` +
        `snapshot the ref came from:\n${snapshot}\nwrong page (${afterAx})`,
    );
  }, LANDS_TIMEOUT_MS);
});
