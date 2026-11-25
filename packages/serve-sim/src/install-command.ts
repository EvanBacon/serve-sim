/**
 * `serve-sim install <app.ipa>`: put a signed iOS build on a physical
 * iPhone from anywhere (cellular too) with Apple's over-the-air
 * `itms-services` install, served over HTTPS through a cloudflared quick
 * tunnel. No simulator, preview server, debugger or serve-sim auth token is
 * involved; the per-run capability URL is the only credential.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { stripVTControlCharacters } from "util";
import { inspectIpa, profileKindLabel, udidStatus, type IpaInfo } from "./install-ipa";
import { encodeQr, renderQrHalfBlocks } from "./install-qr";
import { InstallServer, generateCapability, type InstallEvent, type InstallUrls } from "./install-server";
import {
  CLOUDFLARED_INSTALL_HINT,
  findOnPath,
  normalizePublicOrigin,
  startQuickTunnel,
  tunnelTargetUrl,
} from "./tunnel";

const INSTALL_DEFAULT_PORT = 3412;
const DEFAULT_TTL_MS = 30 * 60_000;
/** After a `--once` download: the link is revoked, but the tunnel stays up this long so the relay can finish sending it. */
const ONCE_GRACE_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

/**
 * `30m`, `2h`, `90s`, `1h30m`; a bare number is minutes. Max 24h.
 * @lintignore Exported for tests.
 */
export function parseTtl(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  let ms: number;
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    ms = Number(s) * 60_000;
  } else {
    if (!/^(?:\d+(?:\.\d+)?[hms])+$/.test(s)) return null;
    ms = 0;
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)([hms])/g)) {
      ms += Number(m[1]) * (m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1000);
    }
  }
  if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_TTL_MS) return null;
  return Math.round(ms);
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h ? `${h}h${m ? `${m}m` : ""}` : `${m}m`;
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface PreparedIpa {
  ipaPath: string;
  cleanup(): void;
}

/**
 * Accept an .ipa, a built .app, or an .xcarchive. A .app (or the one inside
 * an archive's Products/Applications) is zipped as `Payload/<Name>.app` with
 * `ditto`, so this needs macOS for anything but an .ipa.
 * @lintignore Exported for tests.
 */
export function prepareIpa(input: string, platform: NodeJS.Platform = process.platform): PreparedIpa {
  const path = resolve(input.replace(/\/+$/, ""));
  if (!existsSync(path)) throw new Error(`No such file: ${input}`);
  const stat = statSync(path);
  if (stat.isFile()) return { ipaPath: path, cleanup: () => {} };
  if (!stat.isDirectory()) throw new Error(`Not an .ipa, .app or .xcarchive: ${input}`);

  let app = path;
  if (path.endsWith(".xcarchive")) {
    const dir = join(path, "Products", "Applications");
    const apps = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".app")) : [];
    if (apps.length !== 1) throw new Error(`Expected one .app in ${dir}, found ${apps.length}`);
    app = join(dir, apps[0]!);
  } else if (!path.endsWith(".app")) {
    throw new Error(`Not an .ipa, .app or .xcarchive: ${input}`);
  }
  if (platform !== "darwin") throw new Error("Packaging a .app needs macOS (ditto). Pass an .ipa instead.");
  const tmp = mkdtempSync(join(tmpdir(), "serve-sim-install-"));
  const cleanup = () => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  };
  try {
    const payload = join(tmp, "Payload");
    execFileSync("ditto", [app, join(payload, basename(app))], { stdio: "pipe" });
    const ipaPath = join(tmp, `${basename(app, ".app")}.ipa`);
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", payload, ipaPath], { stdio: "pipe" });
    return { ipaPath, cleanup };
  } catch (error) {
    cleanup();
    throw new Error(`Could not package ${basename(app)} as an .ipa: ${(error as Error).message}`);
  }
}

type UdidCheck = { udid: string; status: ReturnType<typeof udidStatus> };

function signingSummary(info: IpaInfo): string {
  const p = info.profile;
  if (!p) return info.signed ? "signed, no profile" : "unsigned";
  const team = p.teamName ? `${p.teamName}${p.teamId ? ` (${p.teamId})` : ""}` : p.teamId;
  const parts = [`${profileKindLabel(p.kind)} profile`];
  if (team) parts.push(`team ${team}`);
  if (p.expiresAt) parts.push(`${p.expired ? "EXPIRED" : "expires"} ${p.expiresAt.slice(0, 10)}`);
  return parts.join(", ");
}

function deviceLines(info: IpaInfo, udid?: UdidCheck): string[] {
  const p = info.profile;
  const lines: string[] = [];
  if (p?.kind === "enterprise") {
    lines.push("  Devices:  any (enterprise profile)");
  } else if (p && p.devices.length > 0) {
    const shown = p.devices.slice(0, 3).join(", ");
    const more = p.devices.length > 3 ? ` (+${p.devices.length - 3} more)` : "";
    lines.push(`  Devices:  ${p.devices.length} provisioned: ${shown}${more}`);
    if (!udid) lines.push("            \x1b[2mYour iPhone must be in this list; find its UDID with `xcrun devicectl list devices`.\x1b[0m");
  }
  if (udid) {
    const label = {
      included: "included",
      "not-included": "\x1b[31mNOT included\x1b[0m (iOS will refuse the install)",
      "all-devices": "included (enterprise profile)",
      "no-profile": "unknown (no provisioning profile)",
    }[udid.status];
    lines.push(`  UDID:     ${udid.udid} ${label}`);
  }
  return lines;
}

/** @lintignore Exported for tests. */
export function formatInstallBanner(b: {
  info: IpaInfo;
  urls: InstallUrls;
  expiresAt: number;
  now: number;
  once: boolean;
  quick: boolean;
  qr: string;
  udid?: UdidCheck;
}): string {
  const { info, urls } = b;
  const version = info.build !== info.version ? `${info.version} (${info.build})` : info.version;
  const lines = [
    "",
    `  \x1b[1m${info.appName}\x1b[0m ${version}`,
    `  Bundle:   ${info.bundleId}`,
    `  Signing:  ${signingSummary(info)}`,
    ...deviceLines(info, b.udid),
  ];
  for (const w of info.warnings) lines.push(`  \x1b[33mwarning:\x1b[0m ${w}`);
  lines.push(
    "",
    "  Scan with the iPhone Camera, or open the page in Safari:",
    "",
    b.qr.split("\n").map((l) => `  ${l}`).join("\n"),
    "",
    `  - Page:     ${urls.page}${b.quick ? " \x1b[2m(quick tunnel; can take a few seconds to resolve)\x1b[0m" : ""}`,
    `  - Direct:   ${urls.itms}`,
    `  - Expires:  ${new Date(b.expiresAt).toLocaleString()} (in ${formatDuration(b.expiresAt - b.now)})${b.once ? ", or after one download" : ""}`,
    "",
    "  Anyone with the link can download the .ipa while it's live. Ctrl+C to stop.",
    "",
  );
  return lines.join("\n");
}

/** @lintignore Exported for tests. */
export function installJson(b: { info: IpaInfo; urls: InstallUrls; expiresAt: number; once: boolean; udid?: UdidCheck }): Record<string, unknown> {
  const { info } = b;
  return {
    app: {
      name: info.appName,
      bundleId: info.bundleId,
      version: info.version,
      build: info.build,
      signed: info.signed,
      hasIcon: !!info.icon,
    },
    profile: info.profile ?? null,
    urls: b.urls,
    expiresAt: new Date(b.expiresAt).toISOString(),
    once: b.once,
    ...(b.udid ? { udid: b.udid } : {}),
    warnings: info.warnings,
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((ok, fail) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      fail(err);
    };
    const onListening = () => {
      server.off("error", onError);
      ok();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function listenOnFreePort(server: Server, start: number, explicit: boolean): Promise<number> {
  const tries = explicit ? 1 : 50;
  for (let i = 0; i < tries; i++) {
    try {
      await listen(server, start + i);
      return start + i;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(explicit
    ? `Port ${start} is already in use. Pass a different --port.`
    : `No free port in ${start}-${start + tries - 1}.`);
}

export interface InstallCommandOptions {
  publicOrigin?: string;
  port?: number;
  ttl?: string;
  once?: boolean;
  json?: boolean;
  udid?: string;
}

/** Cancels a timer started by {@link InstallCommandDeps.setTimer}. */
type CancelTimer = () => void;

/** Seams for tests; production uses the defaults. */
export interface InstallCommandDeps {
  startQuickTunnel?: typeof startQuickTunnel;
  findOnPath?: (name: string) => string | undefined;
  prepareIpa?: (input: string) => PreparedIpa;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => CancelTimer;
  out?: (line: string) => void;
  err?: (line: string) => void;
  onceGraceMs?: number;
}

const defaultSetTimer = (fn: () => void, ms: number): CancelTimer => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

const EVENT_TEXT: Record<InstallEvent, string> = {
  page: "Install page opened",
  manifest: "Manifest fetched",
  "ipa-start": "Downloading app.ipa",
  "ipa-complete": "app.ipa downloaded",
};

/** Runs until Ctrl+C, expiry or (with --once) one full download. Resolves with the exit code. */
export async function installCommand(input: string, opts: InstallCommandOptions, deps: InstallCommandDeps = {}): Promise<number> {
  const err = deps.err ?? ((line: string) => console.error(line));
  const out = deps.out ?? ((line: string) => console.log(line));
  const clock = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const graceMs = deps.onceGraceMs ?? ONCE_GRACE_MS;
  const ttlMs = opts.ttl === undefined ? DEFAULT_TTL_MS : parseTtl(opts.ttl);
  if (ttlMs === null) {
    err(`Invalid --ttl ${opts.ttl}. Use e.g. 30m, 2h, 90s (max 24h).`);
    return 1;
  }
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) {
    err("--port must be a TCP port number.");
    return 1;
  }

  let publicOrigin: string | undefined;
  let cloudflared: string | undefined;
  try {
    if (opts.publicOrigin !== undefined) {
      publicOrigin = normalizePublicOrigin(opts.publicOrigin);
      if (!publicOrigin.startsWith("https://")) throw new Error("--public-origin must be https: iOS only installs OTA over HTTPS.");
    } else {
      cloudflared = (deps.findOnPath ?? findOnPath)("cloudflared");
      if (!cloudflared) throw new Error(CLOUDFLARED_INSTALL_HINT);
    }
  } catch (error) {
    err((error as Error).message);
    return 1;
  }

  let prepared: PreparedIpa;
  let info: IpaInfo;
  try {
    prepared = (deps.prepareIpa ?? prepareIpa)(input);
  } catch (error) {
    err((error as Error).message);
    return 1;
  }
  try {
    info = inspectIpa(prepared.ipaPath);
  } catch (error) {
    prepared.cleanup();
    err(`Could not read ${basename(input)}: ${(error as Error).message}`);
    return 1;
  }
  const udid: UdidCheck | undefined = opts.udid ? { udid: opts.udid.trim(), status: udidStatus(info.profile, opts.udid) } : undefined;
  const ipaSize = statSync(prepared.ipaPath).size;
  const log = opts.json ? err : out;

  let finish!: (code: number) => void;
  const done = new Promise<number>((r) => { finish = r; });
  let stopTunnel: (() => void) | undefined;
  const timers: CancelTimer[] = [];
  let stopped = false;
  const httpServer = createServer();
  const onSignal = () => shutdown(0, "\n  Stopped. The install link no longer works.");
  const onExit = () => {
    stopTunnel?.();
    prepared.cleanup();
  };
  const shutdown = (code: number, message?: string) => {
    if (stopped) return;
    stopped = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", onExit);
    if (message) log(message);
    for (const cancel of timers.splice(0)) cancel();
    stopTunnel?.();
    httpServer.close();
    httpServer.closeAllConnections?.();
    prepared.cleanup();
    finish(code);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", onExit);

  const install = new InstallServer({
    cap: generateCapability(),
    ipaPath: prepared.ipaPath,
    ipaSize,
    appName: info.appName,
    bundleId: info.bundleId,
    version: info.version,
    build: info.build,
    icon: info.icon,
    once: !!opts.once,
    now: clock,
    onEvent: (event) => log(`  › ${EVENT_TEXT[event]}${event === "ipa-complete" ? ` (${formatBytes(ipaSize)})` : ""}`),
    onRevoked: (reason) => {
      if (reason === "once") {
        // `finish` only means the bytes reached cloudflared's socket, not the phone: new requests
        // 404 from now on, but keep the tunnel up while the relay drains.
        log(`  Downloaded once; link revoked. Exiting in ${Math.round(graceMs / 1000)}s (Ctrl+C to exit now).`);
        timers.push(setTimer(() => shutdown(0, "  Stopped."), graceMs));
      } else if (reason === "expired") {
        shutdown(0, "  Link expired. Stopped.");
      }
    },
  });
  httpServer.on("request", install.handle);

  try {
    const port = await listenOnFreePort(httpServer, opts.port ?? INSTALL_DEFAULT_PORT, opts.port !== undefined);
    if (!publicOrigin) {
      const target = tunnelTargetUrl("127.0.0.1", port);
      if (!opts.json) log(`  Starting cloudflared quick tunnel to ${target}...`);
      const tunnel = await (deps.startQuickTunnel ?? startQuickTunnel)({
        bin: cloudflared!,
        targetUrl: target,
        onSpawn: (stop) => { stopTunnel = stop; },
        onExit: (code, signal) => shutdown(1, `  cloudflared exited (${signal ?? `code ${code}`}); the install link is down.`),
      });
      publicOrigin = tunnel.publicOrigin;
    }
  } catch (error) {
    shutdown(1);
    err((error as Error).message);
    return done;
  }
  if (stopped) return done;

  const now = clock();
  const expiresAt = now + ttlMs;
  const urls = install.activate(publicOrigin, expiresAt);
  timers.push(setTimer(() => install.revoke("expired"), ttlMs));

  if (opts.json) {
    out(JSON.stringify(installJson({ info, urls, expiresAt, once: !!opts.once, udid })));
  } else {
    const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
    const qr = renderQrHalfBlocks(encodeQr(urls.page, { ecc: "M" }), { color });
    const banner = formatInstallBanner({ info, urls, expiresAt, now, once: !!opts.once, quick: !!cloudflared, qr, udid });
    log(color ? banner : stripVTControlCharacters(banner));
  }
  return done;
}
