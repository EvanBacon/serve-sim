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
 * The simulators a preview serves (`--restrict-devices`). The middleware
 * reads states, simulators and the event log only through it, and
 * checks every target a request names against `allows` once, before any
 * route runs, so a route added later is restricted without opting in. With
 * no restriction it allows everything.
 */
export interface DeviceScope<Simulator> {
  allows(target: DeviceTarget): boolean;
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
type DeviceSources<Simulator> = Omit<DeviceScope<Simulator>, "allows" | "states"> & {
  states(allows: (udid: string) => boolean): Promise<ServeSimDeviceState[]>;
};

export function deviceScope<Simulator extends { udid: string }>(
  restrictToDevices: readonly string[] | undefined,
  read: DeviceSources<Simulator>,
): DeviceScope<Simulator> {
  if (!restrictToDevices) return { ...read, allows: () => true, states: () => read.states(() => true) };
  const served = new Set(restrictToDevices.map((udid) => udid.toUpperCase()));
  const allows = (target: DeviceTarget) => target !== EVERY_SIMULATOR && served.has(target.toUpperCase());
  const logged = (entry: { device?: string }) => entry.device === undefined || allows(entry.device);
  return {
    allows,
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
