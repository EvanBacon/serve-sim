import type { readEventLog, subscribeEventLog } from "./event-log";
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
 * reads states, the simulator list and the event log only through it, and
 * checks every target a request names against `allows` once, before any
 * route runs, so a route added later is restricted without opting in. With
 * no restriction it allows everything.
 */
export interface DeviceScope<Simulator> {
  allows(target: DeviceTarget): boolean;
  states(): Promise<ServeSimDeviceState[]>;
  simulators(): Promise<Simulator[]>;
  /** Whether host actions may drive `udid`: in scope, and known to the host. */
  isKnown(udid: string): Promise<boolean>;
  /** Event-log entries for served simulators, and those that name none. */
  events: typeof readEventLog;
  onEvent: typeof subscribeEventLog;
}

export function deviceScope<Simulator extends { udid: string }>(
  restrictToDevices: readonly string[] | undefined,
  read: Omit<DeviceScope<Simulator>, "allows">,
): DeviceScope<Simulator> {
  if (!restrictToDevices) return { ...read, allows: () => true };
  const served = new Set(restrictToDevices.map((udid) => udid.toUpperCase()));
  const allows = (target: DeviceTarget) => target !== EVERY_SIMULATOR && served.has(target.toUpperCase());
  const logged = (entry: { device?: string }) => entry.device === undefined || allows(entry.device);
  return {
    allows,
    states: async () => (await read.states()).filter((state) => allows(state.device)),
    simulators: async () => (await read.simulators()).filter((simulator) => allows(simulator.udid)),
    isKnown: async (udid) => allows(udid) && (await read.isKnown(udid)),
    events: (query) => read.events({ ...query, include: logged }),
    onEvent: (subscriber) => read.onEvent((entry) => {
      if (logged(entry)) subscriber(entry);
    }),
  };
}
