import { isBooted, listAllSimulators, readServeSimStates, simulatorName, type SimctlDevice } from "./device-sources";
import { readEventLog, subscribeEventLog } from "./event-log";
import type { RequestContext } from "./request-context";
import type { ServeSimDeviceState } from "./state";

/**
 * What DevTools reach: inspect-webkit lists every booted simulator's web
 * views and cannot tell whose a target is, so it acts on all of them at once.
 */
const EVERY_SIMULATOR = Symbol("every simulator");

/** A simulator UDID a request names, or every simulator at once. */
type DeviceTarget = string | typeof EVERY_SIMULATOR;

/** What `check` reads of a request. */
type DeviceRequest = Pick<RequestContext, "method" | "requestedDevice" | "helperDevice" | "devtools" | "body">;

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
   * and a POST body's `udid` or `device`. Reads the body only when restricted.
   */
  check(request: DeviceRequest): Promise<string | null>;
  states(): Promise<ServeSimDeviceState[]>;
  simulators(): Promise<Simulator[]>;
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
      const refused = (await requestTargets(request)).find((target) => target === EVERY_SIMULATOR || !allows(target));
      if (refused === undefined) return null;
      return refused === EVERY_SIMULATOR ? "DevTools are off in a preview with --restrict-devices" : notServed(refused);
    },
    states: () => read.states(allows),
    simulators: async () => (await read.simulators()).filter((simulator) => allows(simulator.udid)),
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

// A body over its route's cap names nothing here: that route answers 413
// without reading it.
async function requestTargets(request: DeviceRequest): Promise<DeviceTarget[]> {
  const targets: DeviceTarget[] = [request.requestedDevice, request.helperDevice].filter((device) => device !== null);
  if (request.devtools) targets.push(EVERY_SIMULATOR);
  if (request.method === "POST") {
    const body = await request.body();
    const value = body.kind === "read" && body.json.ok ? body.json.value : null;
    if (typeof value === "object" && value !== null) {
      if ("udid" in value && typeof value.udid === "string") targets.push(value.udid);
      if ("device" in value && typeof value.device === "string") targets.push(value.device);
    }
  }
  return targets;
}

/** The scope over this host's simulators, previews and event log. */
export function hostDeviceScope(
  restrictToDevices: readonly string[] | undefined,
  isKnown: (udid: string) => Promise<boolean> = isBooted,
): DeviceScope<SimctlDevice> {
  return deviceScope(restrictToDevices, {
    states: readServeSimStates,
    simulators: listAllSimulators,
    simulatorName: (udid) => simulatorName(udid),
    isKnown,
    events: readEventLog,
    onEvent: subscribeEventLog,
  });
}
