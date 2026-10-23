// Host side of the injected SimHierarchyInjector agent (experimental
// `--experimental-hierarchy-3d`): discovering agents through their registry
// files, talking to their loopback HTTP server, and (re)launching an app with
// the agent injected.
import { execFile } from "child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { request } from "http";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { dirnameOf } from "../runtime";

// Bun bakes a bare `__dirname` into bundles as the build machine's path.
const __dirname = dirnameOf(import.meta.url);

/** Where injected agents write `<pid>.json` ({port, token, …}); 0700. */
const HIERARCHY_REGISTRY_DIR = join(tmpdir(), "serve-sim", "hierarchy");

const DYLIB_NAME = "libSimHierarchyInjector.dylib";
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

export interface AgentRecord {
  pid: number;
  port: number;
  token: string;
  bundleId: string;
  udid: string;
  startedAt: number;
}

/** @lintignore exported for tests */
export function parseAgentRecord(text: string): AgentRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pid = r.pid;
  const port = r.port;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (typeof r.token !== "string" || !/^[0-9a-f]{16,128}$/.test(r.token)) return null;
  return {
    pid,
    port,
    token: r.token,
    bundleId: typeof r.bundleId === "string" ? r.bundleId : "",
    udid: typeof r.udid === "string" ? r.udid : "",
    startedAt: typeof r.startedAt === "number" ? r.startedAt : 0,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Live agents for `udid`, newest first. Registry files of dead processes are
 * removed (an app killed with SIGKILL never runs its atexit cleanup).
 */
export function readAgentRecords(
  udid: string,
  dir = HIERARCHY_REGISTRY_DIR,
  isAlive: (pid: number) => boolean = isPidAlive,
): AgentRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out: AgentRecord[] = [];
  for (const file of files) {
    const path = join(dir, file);
    let record: AgentRecord | null = null;
    try {
      record = parseAgentRecord(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    if (!record || !isAlive(record.pid)) {
      try { unlinkSync(path); } catch {}
      continue;
    }
    if (record.udid === udid) out.push(record);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * The agent to inspect: the one running as the foreground app if we know it,
 * otherwise none — an injected app sitting in the background would show a
 * stale (or empty) tree, which is worse than the accessibility fallback.
 * When the foreground app is unknown (AX bridge not ready), a lone agent is
 * the best guess.
 */
export function pickAgent(records: AgentRecord[], foreground: { bundleId: string; pid: number | null } | null): AgentRecord | null {
  if (!foreground) return records.length === 1 ? records[0]! : null;
  if (foreground.pid != null) {
    const byPid = records.find((r) => r.pid === foreground.pid);
    if (byPid) return byPid;
  }
  return records.find((r) => r.bundleId === foreground.bundleId) ?? null;
}

export interface AgentResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

/** GET `path` from an agent over loopback, bounded in time and size. */
export function agentGet(record: AgentRecord, path: string, { timeoutMs = 15_000, maxBytes = 64 * 1024 * 1024 } = {}): Promise<AgentResponse> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: record.port,
        path,
        method: "GET",
        headers: { "X-Serve-Sim-Token": record.token },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error("Agent response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? "application/octet-stream"),
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Agent request timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** The agent dylib: dist/simhier/ next to the bundle, or dist/ from a source checkout. */
function locateHierarchyDylib(): string | null {
  const candidates = [
    join(__dirname, "simhier", DYLIB_NAME),
    join(__dirname, "..", "dist", "simhier", DYLIB_NAME),
    join(__dirname, "..", "..", "dist", "simhier", DYLIB_NAME),
  ];
  for (const p of candidates) if (existsSync(p)) return resolve(p);
  return null;
}

export function isValidBundleId(bundleId: string): boolean {
  return BUNDLE_ID_RE.test(bundleId);
}

function ensureRegistryDir(dir = HIERARCHY_REGISTRY_DIR): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by umask and ignored for an existing dir.
  chmodSync(dir, 0o700);
}

/** Environment for `simctl launch` that injects the agent. */
function injectionEnv(dylib: string, dir = HIERARCHY_REGISTRY_DIR): Record<string, string> {
  return {
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: dylib,
    SIMCTL_CHILD_SERVE_SIM_HIERARCHY_DIR: dir,
  };
}

/**
 * `simctl launch` output is `<bundle-id>: <pid>`.
 * @lintignore exported for tests
 */
export function parseLaunchPid(stdout: string): number | null {
  const match = stdout.trim().match(/:\s*(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

/** Terminate and relaunch `bundleId` with the hierarchy agent injected. */
export function launchWithAgent(udid: string, bundleId: string): Promise<{ pid: number | null; dylib: string }> {
  if (!isValidBundleId(bundleId)) return Promise.reject(new Error(`Invalid bundle id: ${bundleId}`));
  const dylib = locateHierarchyDylib();
  if (!dylib) {
    return Promise.reject(new Error(`${DYLIB_NAME} not found; rebuild serve-sim (bun run packages/serve-sim/build.ts).`));
  }
  ensureRegistryDir();
  return new Promise((resolvePromise, reject) => {
    execFile(
      "xcrun",
      ["simctl", "launch", "--terminate-running-process", udid, bundleId],
      { env: { ...process.env, ...injectionEnv(dylib) }, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(String(stderr || err.message).trim()));
          return;
        }
        resolvePromise({ pid: parseLaunchPid(String(stdout)), dylib });
      },
    );
  });
}

/** Wait for a freshly launched agent to register and answer. */
export async function waitForAgent(
  udid: string,
  bundleId: string,
  pid: number | null,
  { timeoutMs = 10_000, intervalMs = 150, dir = HIERARCHY_REGISTRY_DIR } = {},
): Promise<AgentRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readAgentRecords(udid, dir).find((r) => r.bundleId === bundleId && (pid == null || r.pid === pid));
    if (record) {
      try {
        const res = await agentGet(record, "/info", { timeoutMs: 1000 });
        if (res.status === 200) return record;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
