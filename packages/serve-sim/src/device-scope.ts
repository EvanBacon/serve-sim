import {
  forgetBootedSimulators,
  isBooted,
  listAllSimulators,
  liveSessions,
  readServeSimStates,
  simulatorName,
  type LiveSession,
  type SimctlDevice,
} from "./device-sources";
import { readEventLog, subscribeEventLog } from "./event-log";
import type { BodyLimit, RequestContext } from "./request-context";
import type { ServeSimDeviceState } from "./state";

/** What `check` reads of a request. */
type DeviceRequest = Pick<RequestContext, "method" | "requestedDevice" | "helperDevice" | "devtools" | "body">;

/** Why a restricted scope refuses a request, and the status that says so. */
type Refusal = { status: 404 | 413; message: string };

/**
 * How much of a POST body `check` reads. With --restrict-devices every owned
 * POST is read here before its route runs, and most routes cap nothing, so an
 * unbounded body would sit in the dev server's memory. A body that names a
 * simulator is `{ udid }` or `{ device }` JSON; /reload's 4 KB is ample, and
 * no route's own cap is smaller.
 */
const CHECK_BODY_LIMIT: BodyLimit = { max: 4 * 1024, size: (chunk) => chunk.length };

/**
 * The simulators a preview serves (`--restrict-devices`). The middleware
 * reads states, simulators and the event log only through it, and `check`s
 * each request once, before any route runs, against everything it names in
 * its URL or body, so a route added later that names simulators the same
 * ways is restricted without opting in. With no restriction it allows
 * everything.
 */
export interface DeviceScope<Simulator> {
  allows(udid: string): boolean;
  /**
   * Why the scope refuses `request`, or null when it serves every simulator
   * the request names: `?device=`, a helper route's, DevTools (all of them),
   * and a POST body's `udid` or `device`. Reads the body only when
   * restricted, and refuses one over `CHECK_BODY_LIMIT`.
   */
  check(request: DeviceRequest): Promise<Refusal | null>;
  states(): Promise<ServeSimDeviceState[]>;
  simulators(): Promise<Simulator[]>;
  /** Make the next booted-set read ask simctl again, after a shutdown. */
  forgetBootedSimulators(): void;
  /** Metro's name for a served simulator, if no other simulator shares it. */
  simulatorName(udid: string): Promise<string | undefined>;
  /** Whether host actions may drive `udid`: in scope, and known to the host. */
  isKnown(udid: string): Promise<boolean>;
  /** Diagnostics of served simulators' live sessions (`device` narrows to one). */
  sessions(device: string | null): Promise<Record<string, unknown>[]>;
  /** Event-log entries for served simulators, and those that name none. */
  events: typeof readEventLog;
  onEvent: typeof subscribeEventLog;
}

/** What a scope reads from, unfiltered except where it takes `allows`. */
type DeviceSources<Simulator> = Omit<DeviceScope<Simulator>, "allows" | "check" | "states" | "sessions"> & {
  states(allows: (udid: string) => boolean): Promise<ServeSimDeviceState[]>;
  liveSessions(device: string | null): Promise<LiveSession[]>;
};

export function deviceScope<Simulator extends { udid: string }>(
  restrictToDevices: readonly string[] | undefined,
  read: DeviceSources<Simulator>,
): DeviceScope<Simulator> {
  if (!restrictToDevices) {
    const { liveSessions: _, ...rest } = read;
    return {
      ...rest,
      allows: () => true,
      check: async () => null,
      states: () => read.states(() => true),
      sessions: (device) => servedSessions(read, device, () => true),
    };
  }
  const served = new Set(restrictToDevices.map((udid) => udid.toUpperCase()));
  const allows = (udid: string) => served.has(udid.toUpperCase());
  const logged = (entry: { device?: string }) => entry.device === undefined || allows(entry.device);
  return {
    allows,
    check: (request) => refusal(request, allows),
    states: () => read.states(allows),
    simulators: async () => (await read.simulators()).filter((simulator) => allows(simulator.udid)),
    forgetBootedSimulators: read.forgetBootedSimulators,
    simulatorName: async (udid) => (allows(udid) ? read.simulatorName(udid) : undefined),
    isKnown: async (udid) => allows(udid) && (await read.isKnown(udid)),
    sessions: (device) => servedSessions(read, device, allows),
    events: (query) => read.events({ ...query, include: (entry) => logged(entry) && (query?.include?.(entry) ?? true) }),
    onEvent: (subscriber) => read.onEvent((entry) => {
      if (logged(entry)) subscriber(entry);
    }),
  };
}

/** Diagnostics of the live sessions `allows` serves; no other session is asked. */
async function servedSessions(
  read: Pick<DeviceSources<unknown>, "liveSessions">,
  device: string | null,
  allows: (udid: string) => boolean,
): Promise<Record<string, unknown>[]> {
  const served = (await read.liveSessions(device)).filter((session) => allows(session.udid));
  return Promise.all(served.map((session) => session.diagnostics()));
}

/** Why a restricted scope refuses `udid`. */
export function notServed(udid: string): string {
  return `${udid === "" ? "An empty device" : udid} is not served by this preview`;
}

async function refusal(request: DeviceRequest, allows: (udid: string) => boolean): Promise<Refusal | null> {
  for (const udid of [request.requestedDevice, request.helperDevice]) {
    if (udid !== null && !allows(udid)) return { status: 404, message: notServed(udid) };
  }
  // inspect-webkit lists every booted simulator's web views and cannot tell
  // whose a target is, so DevTools act on all of them at once.
  if (request.devtools) return { status: 404, message: "DevTools are off in a preview with --restrict-devices" };
  if (request.method !== "POST") return null;
  const body = await request.body(CHECK_BODY_LIMIT);
  if (body.kind === "too-large") return { status: 413, message: "Body too large" };
  const value = body.json.ok ? body.json.value : null;
  if (typeof value !== "object" || value === null) return null;
  const named = { udid: "udid" in value ? value.udid : null, device: "device" in value ? value.device : null };
  for (const field of ["udid", "device"] as const) {
    if (named[field] === undefined || named[field] === null) continue;
    const udid = coerced(named[field]);
    if (udid === null) return { status: 404, message: `An unreadable ${field} is not served by this preview` };
    if (!allows(udid)) return { status: 404, message: notServed(udid) };
  }
  return null;
}

// Routes coerce what they read (`[udid]` passes as `udid`), so `check` does
// too. null when String() throws (`{ "toString": null }`), which `check`
// refuses rather than failing with a 500.
function coerced(value: unknown): string | null {
  try {
    return String(value);
  } catch {
    return null;
  }
}

/** The scope over this host's simulators, previews, sessions and event log. */
export function hostDeviceScope(
  restrictToDevices: readonly string[] | undefined,
  sources: Partial<Pick<DeviceSources<SimctlDevice>, "isKnown" | "liveSessions">> = {},
): DeviceScope<SimctlDevice> {
  return deviceScope(restrictToDevices, {
    states: readServeSimStates,
    simulators: listAllSimulators,
    forgetBootedSimulators,
    simulatorName: (udid) => simulatorName(udid),
    isKnown: sources.isKnown ?? isBooted,
    liveSessions: sources.liveSessions ?? liveSessions,
    events: readEventLog,
    onEvent: subscribeEventLog,
  });
}
