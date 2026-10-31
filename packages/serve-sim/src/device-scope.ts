import {
  forgetBootedSimulators,
  isBooted,
  listAllSimulators,
  readServeSimStates,
  simulatorName,
  type SimctlDevice,
} from "./device-sources";
import { readEventLog, subscribeEventLog } from "./event-log";
import type { BodyLimit, RequestContext } from "./request-context";
import type { ServeSimDeviceState } from "./state";

/**
 * What DevTools reach: inspect-webkit lists every booted simulator's web
 * views and cannot tell whose a target is, so it acts on all of them at once.
 */
const EVERY_SIMULATOR = Symbol("every simulator");

/** A body's `udid` or `device` that String() cannot read, so it names no simulator. */
type Unreadable = { unreadable: "udid" | "device" };

/** A simulator UDID a request names, every simulator at once, or an unreadable name. */
type DeviceTarget = string | typeof EVERY_SIMULATOR | Unreadable;

/** What `check` reads of a request. */
type DeviceRequest = Pick<RequestContext, "method" | "requestedDevice" | "helperDevice" | "devtools" | "body">;

/** Why a restricted scope refuses a request, and the status that says so. */
export type Refusal = { status: 404 | 413; message: string };

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
  /** Event-log entries for served simulators, and those that name none. */
  events: typeof readEventLog;
  onEvent: typeof subscribeEventLog;
}

/** What a scope reads from, unfiltered except where it takes `allows`. */
type DeviceSources<Simulator> = Omit<DeviceScope<Simulator>, "allows" | "check" | "states"> & {
  states(allows: (udid: string) => boolean): Promise<ServeSimDeviceState[]>;
};

export function deviceScope<Simulator extends { udid: string }>(
  restrictToDevices: readonly string[] | undefined,
  read: DeviceSources<Simulator>,
): DeviceScope<Simulator> {
  if (!restrictToDevices) {
    return { ...read, allows: () => true, check: async () => null, states: () => read.states(() => true) };
  }
  const served = new Set(restrictToDevices.map((udid) => udid.toUpperCase()));
  const allows = (udid: string) => served.has(udid.toUpperCase());
  const logged = (entry: { device?: string }) => entry.device === undefined || allows(entry.device);
  return {
    allows,
    check: async (request) => {
      const targets = await requestTargets(request);
      if (targets === TOO_LARGE) return { status: 413, message: "Body too large" };
      const refused = targets.find((target) => typeof target !== "string" || !allows(target));
      if (refused === undefined) return null;
      if (refused === EVERY_SIMULATOR) return { status: 404, message: "DevTools are off in a preview with --restrict-devices" };
      if (typeof refused !== "string") return { status: 404, message: `An unreadable ${refused.unreadable} is not served by this preview` };
      return { status: 404, message: notServed(refused) };
    },
    states: () => read.states(allows),
    simulators: async () => (await read.simulators()).filter((simulator) => allows(simulator.udid)),
    forgetBootedSimulators: read.forgetBootedSimulators,
    simulatorName: async (udid) => (allows(udid) ? read.simulatorName(udid) : undefined),
    isKnown: async (udid) => allows(udid) && (await read.isKnown(udid)),
    events: (query) => read.events({ ...query, include: logged }),
    onEvent: (subscriber) => read.onEvent((entry) => {
      if (logged(entry)) subscriber(entry);
    }),
  };
}

/** Why a restricted scope refuses `udid`. */
export function notServed(udid: string): string {
  return `${udid === "" ? "An empty device" : udid} is not served by this preview`;
}

/** A body over `CHECK_BODY_LIMIT`, which was never read in full. */
const TOO_LARGE = Symbol("too large");

async function requestTargets(request: DeviceRequest): Promise<DeviceTarget[] | typeof TOO_LARGE> {
  const targets: DeviceTarget[] = [request.requestedDevice, request.helperDevice].filter((device) => device !== null);
  if (request.devtools) targets.push(EVERY_SIMULATOR);
  if (request.method === "POST") {
    const body = await request.body(CHECK_BODY_LIMIT);
    if (body.kind === "too-large") return TOO_LARGE;
    const value = body.json.ok ? body.json.value : null;
    if (typeof value === "object" && value !== null) {
      if ("udid" in value && value.udid !== undefined && value.udid !== null) targets.push(bodyTarget("udid", value.udid));
      if ("device" in value && value.device !== undefined && value.device !== null) targets.push(bodyTarget("device", value.device));
    }
  }
  return targets;
}

// Routes coerce what they read (`[udid]` passes as `udid`), so this does too.
// A value String() throws on (`{ "toString": null }`) is refused, not a 500.
function bodyTarget(field: Unreadable["unreadable"], value: unknown): DeviceTarget {
  try {
    return String(value);
  } catch {
    return { unreadable: field };
  }
}

/** The scope over this host's simulators, previews and event log. */
export function hostDeviceScope(
  restrictToDevices: readonly string[] | undefined,
  isKnown: (udid: string) => Promise<boolean> = isBooted,
): DeviceScope<SimctlDevice> {
  return deviceScope(restrictToDevices, {
    states: readServeSimStates,
    simulators: listAllSimulators,
    forgetBootedSimulators,
    simulatorName: (udid) => simulatorName(udid),
    isKnown,
    events: readEventLog,
    onEvent: subscribeEventLog,
  });
}
