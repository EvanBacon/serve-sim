// Reload a React Native app through its Metro dev server, the way pressing
// `r` in the `expo start` / `react-native start` terminal does: broadcast a
// `reload` message on Metro's `/message` socket. Unlike tapping R in the
// guest, this works while a text field is first responder.
//
// Both Expo CLI (createMessageSocket) and the RN community CLI accept
// client broadcasts of `reload` from loopback sockets without an Origin.
import { WebSocket } from "ws";

/** Expo CLI picks the next free port after 8081 when it is taken. */
const DEFAULT_METRO_PORTS: readonly number[] = Array.from({ length: 10 }, (_, i) => 8081 + i);

/**
 * Apps that ignore Metro's `reload` broadcast. RCTDevSettings only registers
 * the packager `reload` handler for the first RN instance, which in Expo Go
 * is its own home app, so the project never reloads. (A CDP `Page.reload`
 * does reload Expo Go, but without its kernel modules: the project red-boxes
 * on "Cannot find native module 'ExpoAsset'".)
 */
const METRO_RELOAD_UNSUPPORTED = new Set(["host.exp.Exponent"]);

/** Metro protocol version for `/message` frames. */
const MESSAGE_PROTOCOL_VERSION = 2;

/** The bits of a Metro `/json/list` inspector target we match on. */
interface MetroTarget {
  appId?: string;
  deviceName?: string;
}

/**
 * Whether a Metro instance serves `bundleId` on this simulator. `/json/list`
 * names the app by `appId` and the device by its iOS name (the simulator's
 * name), so a Metro serving the same app to another device is skipped.
 */
export function metroServesApp(
  targets: readonly MetroTarget[],
  bundleId: string,
  deviceName?: string | null,
): boolean {
  return targets.some((t) =>
    t.appId === bundleId && (!deviceName || !t.deviceName || t.deviceName === deviceName),
  );
}

export interface MetroReloadDeps {
  fetchJson?: (url: string) => Promise<unknown>;
  broadcast?: (port: number, method: string) => Promise<boolean>;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(800) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Send one broadcast frame on Metro's message socket. */
export function broadcastMetroMessage(port: number, method: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/message`);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
      try { ws.close(); } catch {}
    };
    const timer = setTimeout(() => done(false), 1500);
    ws.on("open", () => {
      ws.send(JSON.stringify({ version: MESSAGE_PROTOCOL_VERSION, method }), (err) => done(!err));
    });
    ws.on("error", () => done(false));
  });
}

/** Ports of running Metro servers that serve `bundleId` on `deviceName`. */
export async function findMetroPortsForApp(
  bundleId: string,
  deviceName: string | null | undefined,
  ports: readonly number[] = DEFAULT_METRO_PORTS,
  { fetchJson = defaultFetchJson }: MetroReloadDeps = {},
): Promise<number[]> {
  const matches = await Promise.all(ports.map(async (port) => {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      return Array.isArray(targets) && metroServesApp(targets as MetroTarget[], bundleId, deviceName);
    } catch {
      return false;
    }
  }));
  return ports.filter((_, i) => matches[i]);
}

/**
 * Ask the Metro serving the foreground app to reload it. Resolves to the
 * ports that accepted the broadcast; empty means the caller should fall back
 * to tapping R in the guest (Expo Go, no Metro found, or an app without an
 * inspector connection such as a release build).
 */
export async function reloadViaMetro(
  bundleId: string,
  deviceName: string | null | undefined,
  ports: readonly number[] = DEFAULT_METRO_PORTS,
  deps: MetroReloadDeps = {},
): Promise<number[]> {
  if (METRO_RELOAD_UNSUPPORTED.has(bundleId)) return [];
  const broadcast = deps.broadcast ?? broadcastMetroMessage;
  const candidates = await findMetroPortsForApp(bundleId, deviceName, ports, deps);
  const sent = await Promise.all(candidates.map((port) => broadcast(port, "reload")));
  return candidates.filter((_, i) => sent[i]);
}
