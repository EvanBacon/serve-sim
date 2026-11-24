/**
 * The saved remote profile behind `serve-sim connect <url>` / `disconnect`.
 *
 * It holds routing metadata only (the preview URL and when it was saved).
 * The auth token is a bearer secret and is never written here: commands read
 * it from `--auth-token` / `SERVE_SIM_AUTH_TOKEN` on every run.
 *
 * Pure Node (fs/os/path): safe to load on Linux, no simctl or native addon.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const REMOTE_URL_ENV = "SERVE_SIM_URL";

export interface RemoteProfile {
  /** Preview base URL, no trailing slash, no query or fragment. */
  url: string;
  savedAt: string;
}

export type RemoteUrlSource = "flag" | "env" | "profile";

/** `$XDG_CONFIG_HOME/serve-sim/remote.json`, else `~/.config/serve-sim/remote.json`. */
export function remoteProfilePath(env: NodeJS.ProcessEnv = process.env, home: () => string = homedir): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.startsWith("/") ? xdg : join(env.HOME?.trim() || home(), ".config");
  return join(base, "serve-sim", "remote.json");
}

/**
 * Validate a remote preview URL and return it without a trailing slash.
 * Throws with a user-facing message. Credentials in the URL are refused so a
 * token can never end up in the profile (or in proxy logs via `?token=`).
 */
export function normalizeRemoteUrl(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw || "(empty)"}. Pass the preview origin, e.g. https://example.trycloudflare.com`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme ${url.protocol} (use https:// or http://)`);
  }
  if (url.username || url.password) {
    throw new Error("Don't put credentials in the URL. Set SERVE_SIM_AUTH_TOKEN instead.");
  }
  if (url.search || url.hash) {
    throw new Error(
      "Pass the preview URL without a query or fragment. The token goes in SERVE_SIM_AUTH_TOKEN, never in the URL.",
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function loadRemoteProfile(path: string = remoteProfilePath()): RemoteProfile | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Partial<RemoteProfile> | null;
    if (!parsed || typeof parsed.url !== "string") return undefined;
    return { url: normalizeRemoteUrl(parsed.url), savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "" };
  } catch {
    return undefined;
  }
}

/** Write the profile atomically: directory 0700, file 0600. Only `url` and `savedAt` are stored. */
export function saveRemoteProfile(url: string, path: string = remoteProfilePath(), now: Date = new Date()): RemoteProfile {
  const profile: RemoteProfile = { url: normalizeRemoteUrl(url), savedAt: now.toISOString() };
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return profile;
}

/** Remove the saved profile. Returns the profile that was removed, if any. */
export function removeRemoteProfile(path: string = remoteProfilePath()): RemoteProfile | undefined {
  const existing = loadRemoteProfile(path);
  rmSync(path, { force: true });
  return existing;
}

/**
 * Where the input commands should send their requests: `--url`, then
 * `SERVE_SIM_URL`, then the saved profile. `undefined` means the local
 * state file (`$TMPDIR/serve-sim`).
 */
export function resolveRemoteUrl(opts: {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  profile?: () => RemoteProfile | undefined;
}): { url: string; source: RemoteUrlSource } | undefined {
  const flag = opts.flag?.trim();
  if (flag) return { url: flag, source: "flag" };
  const fromEnv = (opts.env ?? process.env)[REMOTE_URL_ENV]?.trim();
  if (fromEnv) return { url: fromEnv, source: "env" };
  const profile = opts.profile?.();
  if (profile) return { url: profile.url, source: "profile" };
  return undefined;
}

export function describeRemoteUrlSource(source: RemoteUrlSource, path: string = remoteProfilePath()): string {
  if (source === "flag") return "--url";
  if (source === "env") return REMOTE_URL_ENV;
  return `saved profile ${path}, cleared by \`serve-sim disconnect\``;
}
