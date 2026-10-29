/**
 * What DevTools reach: inspect-webkit lists every booted simulator's web
 * views and cannot tell whose a target is, so it acts on all of them at once.
 */
export const EVERY_SIMULATOR = Symbol("every simulator");

/** A simulator UDID a request names, or every simulator at once. */
export type DeviceTarget = string | typeof EVERY_SIMULATOR;

/**
 * The simulators a preview serves (`--restrict-devices`). The middleware
 * reads states and the simulator list only through it, and checks every
 * target a request names against `allows` once, before any route runs, so a
 * route added later is restricted without opting in. With no restriction it
 * allows everything.
 */
export interface DeviceScope<State, Simulator> {
  allows(target: DeviceTarget): boolean;
  states(): Promise<State[]>;
  simulators(): Promise<Simulator[]>;
  /** Whether host actions may drive `udid`: in scope, and known to the host. */
  isKnown(udid: string): Promise<boolean>;
}

export function deviceScope<State extends { device: string }, Simulator extends { udid: string }>(
  restrictToDevices: readonly string[] | undefined,
  read: {
    states(): Promise<State[]>;
    simulators(): Promise<Simulator[]>;
    isKnown(udid: string): Promise<boolean>;
  },
): DeviceScope<State, Simulator> {
  if (!restrictToDevices) {
    return { allows: () => true, states: read.states, simulators: read.simulators, isKnown: read.isKnown };
  }
  const served = new Set(restrictToDevices.map((udid) => udid.toUpperCase()));
  const allows = (target: DeviceTarget) => target !== EVERY_SIMULATOR && served.has(target.toUpperCase());
  return {
    allows,
    states: async () => (await read.states()).filter((state) => allows(state.device)),
    simulators: async () => (await read.simulators()).filter((simulator) => allows(simulator.udid)),
    isKnown: async (udid) => allows(udid) && (await read.isKnown(udid)),
  };
}
