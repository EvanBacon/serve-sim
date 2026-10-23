// Reload a React Native app through its Metro dev server, like pressing `r`
// in the `expo start` / `react-native start` terminal. Unlike tapping R in
// the guest, this works while a text field is first responder.
//
// Metro's `/message` socket has no device-targeted reload: a `reload`
// broadcast reaches every app connected to that Metro, and app sockets only
// identify themselves by platform (`?role=ios`). So a reload is only sent
// when the Metro serves this app on this simulator and nothing else:
//   - `/json/list` (inspector targets) shows exactly one device, ours;
//   - `getpeers` shows exactly one connected app socket, which is then the
//     only recipient of a targeted `reload` request. Metros that don't answer
//     `getpeers`, or answer it with an error (the community CLI's
//     `react-native start` server throws on current `ws`), get a broadcast,
//     which by the check above reaches only this device. A device on the
//     message socket without an inspector connection isn't in `/json/list`,
//     so in that case a broadcast could also reach it.
// Anything else (no Metro, several devices or apps, Expo Go) is reported as
// not sent so the caller can tap R in the guest instead. Metro is only looked
// for on ports 8081-8090; Metro on any other port always gets the R tap.
//
// The whole attempt is time-boxed (METRO_RELOAD_SERVER_BUDGET_MS) so the
// browser, which waits a little longer than that, always learns whether a
// reload went out and can tap R when it didn't.
//
// Metro does not acknowledge `reload`, so `sent` means it was delivered to
// Metro for this app's socket, not that the app finished reloading.
import { WebSocket } from "ws";

/** Expo CLI picks the next free port after 8081 when it is taken. */
const DEFAULT_METRO_PORTS: readonly number[] = Array.from({ length: 10 }, (_, i) => 8081 + i);

/**
 * Apps that ignore Metro's `reload` message. RCTDevSettings only registers
 * the packager `reload` handler for the first RN instance, which in Expo Go
 * is its own home app, so the project never reloads. (A CDP `Page.reload`
 * does reload Expo Go, but without its kernel modules: the project red-boxes
 * on "Cannot find native module 'ExpoAsset'".)
 */
const METRO_RELOAD_UNSUPPORTED = new Set(["host.exp.Exponent"]);

/** Whether `bundleId` can be reloaded through Metro at all. */
export function supportsMetroReload(bundleId: string): boolean {
  return !METRO_RELOAD_UNSUPPORTED.has(bundleId);
}

/** Max time spent finding the device name and the Metro before giving up. */
const METRO_LOOKUP_BUDGET_MS = 1000;
/** Max time the `/message` session may take once a Metro is chosen. */
const METRO_SEND_TIMEOUT_MS = 1200;
/** Upper bound on a whole `reloadViaMetro` call (lookup + send). */
export const METRO_RELOAD_SERVER_BUDGET_MS = METRO_LOOKUP_BUDGET_MS + METRO_SEND_TIMEOUT_MS;

/** Metro protocol version for `/message` frames. */
const MESSAGE_PROTOCOL_VERSION = 2;

/** The bits of a Metro `/json/list` inspector target we match on. */
interface MetroTarget {
  appId?: string;
  deviceName?: string;
  reactNative?: { logicalDeviceId?: string };
}

/** Devices with an inspector connection to a Metro, keyed by logical id. */
function connectedDevices(targets: readonly MetroTarget[]): Map<string, string | undefined> {
  const devices = new Map<string, string | undefined>();
  for (const t of targets) {
    if (!t.appId) continue;
    const key = t.reactNative?.logicalDeviceId ?? t.deviceName ?? t.appId;
    devices.set(key, t.deviceName);
  }
  return devices;
}

/**
 * Whether a Metro instance serves `bundleId` on `deviceName` (the
 * simulator's name, which is what iOS reports in `/json/list`).
 */
export function metroServesApp(
  targets: readonly MetroTarget[],
  bundleId: string,
  deviceName: string,
): boolean {
  return targets.some((t) => t.appId === bundleId && t.deviceName === deviceName);
}

/**
 * Whether a `reload` sent to this Metro could only reach `deviceName`: it
 * serves `bundleId` there and no other device is connected.
 */
export function metroServesOnlyDevice(
  targets: readonly MetroTarget[],
  bundleId: string,
  deviceName: string,
): boolean {
  if (!metroServesApp(targets, bundleId, deviceName)) return false;
  const devices = connectedDevices(targets);
  return devices.size === 1 && [...devices.values()][0] === deviceName;
}

export type MetroReloadResult =
  | { sent: true; port: number; targeted: boolean }
  | {
      sent: false;
      reason: "unsupported-app" | "unknown-device" | "no-metro" | "ambiguous" | "send-failed" | "timeout";
      ports?: number[];
    };

/**
 * Outcome of one `/message` session: `targeted`/`broadcast` were sent,
 * `ambiguous` means several app sockets are connected, `failed` means
 * nothing was sent.
 */
export type MetroSendOutcome = "targeted" | "broadcast" | "ambiguous" | "failed";

export interface MetroReloadDeps {
  fetchJson?: (url: string) => Promise<unknown>;
  sendReload?: (port: number) => Promise<MetroSendOutcome>;
  /** Overrides METRO_LOOKUP_BUDGET_MS (tests). */
  lookupBudgetMs?: number;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(800) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * App sockets in a `getpeers` result; tools connect without a `role`. Metro
 * reports each peer's query either as a raw string or as a parsed object.
 */
export function appPeerIds(peers: unknown): string[] {
  if (!peers || typeof peers !== "object") return [];
  return Object.entries(peers as Record<string, unknown>)
    .filter(([, query]) => hasRole(query))
    .map(([id]) => id);
}

function hasRole(query: unknown): boolean {
  if (typeof query === "string") return new URLSearchParams(query).has("role");
  if (query && typeof query === "object") return (query as { role?: unknown }).role != null;
  return false;
}

/**
 * Send `reload` on Metro's message socket. Asks Metro for its peers first;
 * with exactly one app connected the reload is addressed to that socket
 * only. If Metro doesn't answer `getpeers`, or answers with an error, the
 * reload is broadcast, which the caller only allows when a single device is
 * connected.
 */
export function sendMetroReload(
  port: number,
  { peersTimeoutMs = 500, timeoutMs = METRO_SEND_TIMEOUT_MS }: { peersTimeoutMs?: number; timeoutMs?: number } = {},
): Promise<MetroSendOutcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/message`);
    const peersId = `serve-sim-peers-${Date.now()}`;
    let peersTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    // Once the reload frame is handed to the socket it may reach the app, so
    // a timeout after that point must not be reported as "nothing sent".
    let pending: MetroSendOutcome | null = null;
    const done = (outcome: MetroSendOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(peersTimer);
      resolve(outcome);
      try { ws.close(); } catch {}
    };
    const timer = setTimeout(() => done(pending ?? "failed"), timeoutMs);
    const send = (frame: Record<string, unknown>, outcome: MetroSendOutcome) => {
      if (settled || pending) return;
      clearTimeout(peersTimer);
      pending = outcome;
      ws.send(JSON.stringify({ version: MESSAGE_PROTOCOL_VERSION, ...frame }), (err) =>
        done(err ? "failed" : outcome),
      );
    };
    ws.on("open", () => {
      ws.send(JSON.stringify({ version: MESSAGE_PROTOCOL_VERSION, id: peersId, method: "getpeers", target: "server" }));
      peersTimer = setTimeout(() => send({ method: "reload" }, "broadcast"), peersTimeoutMs);
    });
    ws.on("message", (data) => {
      let msg: { id?: unknown; result?: unknown; error?: unknown };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id !== peersId || pending) return;
      // An error means Metro couldn't list peers, not that none are
      // connected, so treat it like no answer.
      if (msg.error !== undefined && msg.result === undefined) {
        send({ method: "reload" }, "broadcast");
        return;
      }
      const apps = appPeerIds(msg.result);
      if (apps.length === 1) send({ method: "reload", target: apps[0] }, "targeted");
      else done(apps.length === 0 ? "failed" : "ambiguous");
    });
    ws.on("error", () => done(pending ?? "failed"));
  });
}

/** `/json/list` of each Metro port that answers, keyed by port. */
async function probeMetros(
  ports: readonly number[],
  fetchJson: (url: string) => Promise<unknown>,
): Promise<Map<number, MetroTarget[]>> {
  const lists = await Promise.all(ports.map(async (port) => {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      return Array.isArray(targets) ? (targets as MetroTarget[]) : null;
    } catch {
      return null;
    }
  }));
  const found = new Map<number, MetroTarget[]>();
  ports.forEach((port, i) => {
    if (lists[i]) found.set(port, lists[i]!);
  });
  return found;
}

/**
 * Reload the foreground app through the Metro that serves it on this
 * simulator. `sent: false` means no reload went out and the caller should
 * tap R in the guest instead.
 *
 * `deviceName` may be a promise (e.g. a `simctl` lookup); it is resolved
 * alongside the Metro probes, and if both don't finish within the lookup
 * budget nothing is sent (`reason: "timeout"`).
 */
export async function reloadViaMetro(
  bundleId: string,
  deviceName: string | null | undefined | PromiseLike<string | null | undefined>,
  ports: readonly number[] = DEFAULT_METRO_PORTS,
  {
    fetchJson = defaultFetchJson,
    sendReload = (port) => sendMetroReload(port),
    lookupBudgetMs = METRO_LOOKUP_BUDGET_MS,
  }: MetroReloadDeps = {},
): Promise<MetroReloadResult> {
  if (!supportsMetroReload(bundleId)) return { sent: false, reason: "unsupported-app" };
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const lookup = await Promise.race([
    Promise.all([Promise.resolve(deviceName).catch(() => null), probeMetros(ports, fetchJson)]),
    new Promise<null>((resolve) => { budgetTimer = setTimeout(() => resolve(null), lookupBudgetMs); }),
  ]).finally(() => clearTimeout(budgetTimer));
  if (!lookup) return { sent: false, reason: "timeout" };
  const [name, metros] = lookup;
  if (!name) return { sent: false, reason: "unknown-device" };
  const serving = [...metros].filter(([, targets]) => metroServesApp(targets, bundleId, name));
  if (serving.length === 0) return { sent: false, reason: "no-metro" };
  const servingPorts = serving.map(([port]) => port);
  if (serving.length > 1 || !metroServesOnlyDevice(serving[0]![1], bundleId, name)) {
    return { sent: false, reason: "ambiguous", ports: servingPorts };
  }
  const port = servingPorts[0]!;
  const outcome = await sendReload(port);
  if (outcome === "targeted" || outcome === "broadcast") {
    return { sent: true, port, targeted: outcome === "targeted" };
  }
  return { sent: false, reason: outcome === "ambiguous" ? "ambiguous" : "send-failed", ports: servingPorts };
}
