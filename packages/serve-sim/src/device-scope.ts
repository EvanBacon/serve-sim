import { isBooted, listAllSimulators, readServeSimStates, simulatorName, type SimctlDevice } from "./device-sources";
import { readEventLog, subscribeEventLog } from "./event-log";
import type { ServeSimDeviceState } from "./state";

/**
 * What DevTools reach: inspect-webkit lists every booted simulator's web
 * views and cannot tell whose a target is, so it acts on all of them at once.
 */
export const EVERY_SIMULATOR = Symbol("every simulator");

/** A simulator UDID a request names, or every simulator at once. */
export type DeviceTarget = string | typeof EVERY_SIMULATOR;

/**
 * What a request names, parsed once by the middleware: the simulators in its
 * URL (`?device=` and a helper route's own), whether it reaches DevTools,
 * and its JSON body, whose `udid` and `device` fields name simulators too.
 */
export interface DeviceRequest {
  devices: readonly string[];
  devtools: boolean;
  body: unknown;
}

/**
 * The simulators a preview serves (`--restrict-devices`). The middleware
 * reads states, simulators and the event log only through it, and `check`s
 * each request once, before any route runs, against everything it names in
 * its URL or body, so a route added later is restricted without opting in.
 * With no restriction it allows everything.
 */
export interface DeviceScope<Simulator> {
  allows(target: DeviceTarget): boolean;
  /** Why the scope refuses `request`, or null when it serves everything it names. */
  check(request: DeviceRequest): string | null;
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
    return { ...read, allows: () => true, check: () => null, states: () => read.states(() => true) };
  }
  const served = new Set(restrictToDevices.map((udid) => udid.toUpperCase()));
  const allows = (target: DeviceTarget) => target !== EVERY_SIMULATOR && served.has(target.toUpperCase());
  const logged = (entry: { device?: string }) => entry.device === undefined || allows(entry.device);
  return {
    allows,
    check: (request) => {
      const refused = requestTargets(request).find((target) => !allows(target));
      if (refused === undefined) return null;
      return refused === EVERY_SIMULATOR
        ? "DevTools are off in a preview with --restrict-devices"
        : `${refused === "" ? "An empty device" : refused} is not served by this preview`;
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

function requestTargets({ devices, devtools, body }: DeviceRequest): DeviceTarget[] {
  const targets: DeviceTarget[] = [...devices];
  if (devtools) targets.push(EVERY_SIMULATOR);
  if (typeof body === "object" && body !== null) {
    if ("udid" in body && typeof body.udid === "string") targets.push(body.udid);
    if ("device" in body && typeof body.device === "string") targets.push(body.device);
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
