import { execFile } from "child_process";
import { readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { debugMw } from "./debug";
import { closeDeviceSession, liveDeviceSessions } from "./device-session";
import { classifyStaleState, persistRecoveredState, resolveLiveHelperState } from "./helper-lifecycle";
import { uniqueSimulatorName } from "./metro-reload";
import { resolveDeviceSet, sameDeviceSet, simctlArguments } from "./simctl";
import { STATE_DIR, type ServeSimDeviceState } from "./state";

// Every simulator and preview on the host, unfiltered. Only device-scope.ts
// reads these, so simMiddleware sees what its preview serves and no more.

type SimctlBootedList = {
  devices: Record<string, Array<{ udid: string; state: string }>>;
};

type SimctlAllList = {
  devices: Record<string, Array<Omit<SimctlDevice, "runtime">>>;
};

// Cache simctl's booted-device set briefly so per-request cost stays bounded.
// The middleware runs inside the user's dev server (Metro etc.) and
// readServeSimStates() is called on every /api and every page load.
let bootedSnapshot: { at: number; booted: Set<string> | null } = { at: 0, booted: null };
async function getBootedUdids(): Promise<Set<string> | null> {
  const now = Date.now();
  if (bootedSnapshot.booted && now - bootedSnapshot.at < 1500) {
    return bootedSnapshot.booted;
  }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "xcrun",
        simctlArguments(["list", "devices", "booted", "-j"]),
        { encoding: "utf-8", timeout: 3_000 },
        (err, stdout) => {
          if (err) {
            reject(err);
          } else {
            resolve(stdout);
          }
        },
      );
    });
    const data = JSON.parse(stdout) as SimctlBootedList;
    const booted = new Set<string>();
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.state === "Booted") booted.add(device.udid);
      }
    }
    bootedSnapshot = { at: now, booted };
    return booted;
  } catch {
    return null;
  }
}

export async function isBooted(udid: string): Promise<boolean> {
  return (await getBootedUdids())?.has(udid) ?? false;
}

/** Make the next booted-set read ask simctl again, after a shutdown. */
export function forgetBootedSimulators(): void {
  bootedSnapshot = { at: 0, booted: null };
}

/**
 * Live previews of the simulators `allows` passes (default: every one).
 * Another simulator's state file is skipped before it is read as stale, so
 * its helper is never stopped.
 */
export async function readServeSimStates(
  allows: (udid: string) => boolean = () => true,
): Promise<ServeSimDeviceState[]> {
  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter(
      (f) => f.startsWith("server-") && f.endsWith(".json"),
    );
  } catch {
    return [];
  }
  const booted = await getBootedUdids();
  const deviceSet = resolveDeviceSet();
  const states: ServeSimDeviceState[] = [];
  for (const f of files) {
    const path = join(STATE_DIR, f);
    try {
      const recorded: ServeSimDeviceState = JSON.parse(readFileSync(path, "utf-8"));
      if (!allows(recorded.device)) continue;
      const state = resolveLiveHelperState(recorded);
      if (!state) {
        debugMw("helper pid=%d gone, removing %s", recorded.pid, path);
        try { unlinkSync(path); } catch {}
        continue;
      }
      if (state.pid !== recorded.pid) persistRecoveredState(state);
      // Previews in every device set share this folder; another set's
      // simulator is not one this preview can stream.
      if (!sameDeviceSet(state.deviceSet, deviceSet)) continue;
      // Helper alive but its simulator was shut down — the MJPEG stream
      // would accept connections yet never produce frames, leaving the
      // preview stuck on "Connecting...". Recycle the stale state so the
      // caller can spawn a fresh helper bound to whatever is booted.
      const action = classifyStaleState(state, booted, process.pid, deviceSet);
      if (action !== "keep") {
        if (action === "recycle-self") {
          // This device is streamed in-process by *us* (the close button just
          // shut its sim down). SIGTERMing state.pid would kill the whole
          // server; instead stop just this device's capture session.
          debugMw(
            "closing in-process session for shut-down device %s (own pid %d)",
            state.device,
            state.pid,
          );
          closeDeviceSession(state.device);
        } else {
          debugMw(
            "asking stale helper pid=%d to exit (device %s no longer booted)",
            state.pid,
            state.device,
          );
          try { process.kill(state.pid, "SIGTERM"); } catch {}
        }
        // Keep the pidfile while the process is alive so `--list` / `--kill`
        // can still find a detached helper after simctl shutdown. The file
        // is dropped the next time the pid is observed dead.
        continue;
      }
      states.push(state);
    } catch {}
  }
  return states;
}

export interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
  runtime: string;
}

/**
 * Metro device name for `udid`; undefined if another booted sim shares it or
 * the listing fails. Always lists afresh — a cached listing could miss a twin
 * booted since — and POST /reload's lookup budget bounds the wait, falling
 * back to tapping R rather than reloading from stale data.
 */
export async function simulatorName(
  udid: string,
  listSimulators: () => Promise<readonly { udid: string; name: string; state: string }[]> = listAllSimulators,
): Promise<string | undefined> {
  return uniqueSimulatorName(await listSimulators(), udid);
}

export function listAllSimulators(): Promise<SimctlDevice[]> {
  return new Promise((resolve) => {
    execFile(
      "xcrun",
      simctlArguments(["list", "devices", "-j"]),
      { encoding: "utf-8", timeout: 3_000 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const data = JSON.parse(stdout) as SimctlAllList;
          const out: SimctlDevice[] = [];
          for (const [runtime, devices] of Object.entries(data.devices)) {
            // Keep this to touch-capable simulator families that serve-sim can
            // frame and inject into. tvOS is intentionally left out for now.
            if (!/SimRuntime\.(iOS|watchOS|visionOS|xrOS)-/i.test(runtime)) continue;
            for (const d of devices) {
              if (d.isAvailable === false) continue;
              out.push({ ...d, runtime: runtime.replace(/^.*SimRuntime\./, "") });
            }
          }
          resolve(out);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/** A live session, asked for its diagnostics only once a scope serves it. */
export type LiveSession = { udid: string; diagnostics(): Promise<Record<string, unknown>> };

/** Live sessions only (`device` narrows to one); never starts capture. */
export async function liveSessions(device: string | null): Promise<LiveSession[]> {
  return liveDeviceSessions(device);
}
