// Routes for the experimental 3D view-hierarchy inspector. Mounted by
// simMiddleware only when `experimentalHierarchy3d` is set
// (`serve-sim --experimental-hierarchy-3d`); otherwise none of these paths
// exist and the preview behaves exactly as before.
//
//   GET  {base}/hierarchy-3d                    the inspector page
//   GET  {base}/hierarchy-3d/api/capture        HierarchyCaptureResponse JSON
//   GET  {base}/hierarchy-3d/api/snapshot       a view PNG proxied from the agent
//   GET  {base}/hierarchy-3d/api/screenshot     whole-screen PNG (AX fallback)
//   POST {base}/hierarchy-3d/api/inject         relaunch an app with the agent
import { execFile } from "child_process";
import { readFile, unlink } from "fs/promises";
import type { IncomingMessage, ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  agentGet,
  isValidBundleId,
  launchWithAgent,
  pickAgent,
  readAgentRecords,
  waitForAgent,
  type AgentRecord,
  type AgentResponse,
} from "./agent";
import { axTreeToCapture, normalizeAgentCapture, type HierarchyCaptureResponse } from "./model";
import { axDescribeAsync, axFrontmostAsync } from "../native";

declare const __HIERARCHY_3D_HTML_B64__: string | undefined;

export const HIERARCHY_3D_PATH = "/hierarchy-3d";

export interface Hierarchy3dDeps {
  readAgents(udid: string): AgentRecord[];
  agentGet(record: AgentRecord, path: string): Promise<AgentResponse>;
  frontmost(udid: string): Promise<{ bundleId: string; pid: number | null } | null>;
  describeAx(udid: string): Promise<unknown>;
  screenshot(udid: string): Promise<Buffer>;
  launchWithAgent(udid: string, bundleId: string): Promise<{ pid: number | null }>;
  waitForAgent(udid: string, pid: number | null): Promise<AgentRecord | null>;
  /** The page HTML; null when this build doesn't include it. */
  pageHtml(): string | null;
}

export interface Hierarchy3dRequest {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  rawUrl: string;
  /** Resolved simulator for this request, or null if none is being served. */
  udid: string | null;
  /** Only trusted loopback pages may relaunch apps. */
  trustedLoopback: boolean;
}

let cachedHtml: string | null | undefined;
function builtPageHtml(): string | null {
  if (cachedHtml === undefined) {
    cachedHtml = typeof __HIERARCHY_3D_HTML_B64__ === "string"
      ? Buffer.from(__HIERARCHY_3D_HTML_B64__, "base64").toString("utf-8")
      : null;
  }
  return cachedHtml;
}

async function simctlScreenshot(udid: string): Promise<Buffer> {
  // `simctl io screenshot -` writes a file literally named "-", so go via a temp file.
  const path = join(tmpdir(), `serve-sim-hierarchy-shot-${randomUUID()}.png`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", path], { timeout: 15_000 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    return await readFile(path);
  } finally {
    unlink(path).catch(() => {});
  }
}

function defaultDeps(): Hierarchy3dDeps {
  return {
    readAgents: (udid) => readAgentRecords(udid),
    agentGet: (record, path) => agentGet(record, path),
    async frontmost(udid) {
      try {
        const info = JSON.parse(await axFrontmostAsync(udid)) as { bundleId?: string; pid?: number };
        return info.bundleId ? { bundleId: info.bundleId, pid: typeof info.pid === "number" ? info.pid : null } : null;
      } catch {
        return null;
      }
    },
    describeAx: async (udid) => JSON.parse(await axDescribeAsync(udid)),
    screenshot: simctlScreenshot,
    launchWithAgent,
    waitForAgent: (udid, pid) => waitForAgent(udid, pid),
    pageHtml: builtPageHtml,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function escapeForScript(json: string): string {
  return json.replace(/</g, "\\u003c");
}

export function createHierarchy3dHandler(options: { base: string; deps?: Partial<Hierarchy3dDeps> }) {
  const root = `${options.base}${HIERARCHY_3D_PATH}`;
  const api = `${root}/api`;
  const deps: Hierarchy3dDeps = { ...defaultDeps(), ...options.deps };
  let axCaptureSeq = 0;

  const deviceQuery = (udid: string) => `device=${encodeURIComponent(udid)}`;

  async function capture(udid: string, params: URLSearchParams, trustedLoopback: boolean): Promise<HierarchyCaptureResponse> {
    const foreground = await deps.frontmost(udid);
    const agents = deps.readAgents(udid);
    const agent = pickAgent(agents, foreground);
    const snapshots = params.get("snapshots") === "0" ? "0" : "1";
    let notice: string | undefined;
    if (agent) {
      try {
        const res = await deps.agentGet(agent, `/hierarchy?snapshots=${snapshots}`);
        if (res.status !== 200) throw new Error(`agent answered ${res.status}`);
        const parsed = normalizeAgentCapture(JSON.parse(res.body.toString("utf-8")), (captureId, viewId) =>
          `${api}/snapshot?${deviceQuery(udid)}&pid=${agent.pid}&capture=${encodeURIComponent(captureId)}&id=${encodeURIComponent(viewId)}`,
        );
        return { capture: parsed, foreground: foreground ?? { bundleId: agent.bundleId, pid: agent.pid }, canInject: trustedLoopback };
      } catch (err) {
        notice = `The injected inspector in ${agent.bundleId} didn't answer (${err instanceof Error ? err.message : String(err)}); showing the accessibility tree instead.`;
      }
    } else if (foreground) {
      notice = `${foreground.bundleId} wasn't launched with the hierarchy inspector, so this is its accessibility tree textured from a screenshot.`;
    }
    try {
      const raw = await deps.describeAx(udid);
      const parsed = axTreeToCapture(raw, {
        captureId: `ax${++axCaptureSeq}`,
        bundleId: foreground?.bundleId ?? null,
        pid: foreground?.pid ?? null,
        screenshotUrl: `${api}/screenshot?${deviceQuery(udid)}&t=${Date.now()}`,
      });
      return { capture: parsed, foreground, canInject: trustedLoopback, ...(notice ? { notice } : {}) };
    } catch (err) {
      return {
        capture: null,
        foreground,
        canInject: trustedLoopback,
        ...(notice ? { notice } : {}),
        error: `Accessibility unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return async function handle(ctx: Hierarchy3dRequest): Promise<boolean> {
    const { req, res, pathname, rawUrl, udid, trustedLoopback } = ctx;
    if (pathname !== root && pathname !== `${root}/` && !pathname.startsWith(`${api}/`)) return false;
    const method = (req.method ?? "GET").toUpperCase();
    const q = rawUrl.indexOf("?");
    const params = new URLSearchParams(q === -1 ? "" : rawUrl.slice(q + 1));

    if (pathname === root || pathname === `${root}/`) {
      const html = deps.pageHtml();
      if (!html) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("The 3D hierarchy page isn't part of this build. Rebuild with bun run packages/serve-sim/build.ts.");
        return true;
      }
      const config = escapeForScript(JSON.stringify({ basePath: options.base, device: udid }));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html.replace("<!--__SIM_HIERARCHY_3D_CONFIG__-->", `<script>window.__SIM_HIERARCHY_3D__=${config}</script>`));
      return true;
    }

    if (!udid) {
      sendJson(res, 404, { error: "no_device", message: "No serve-sim device" });
      return true;
    }
    if (pathname === `${api}/capture` && method === "GET") {
      sendJson(res, 200, await capture(udid, params, trustedLoopback));
      return true;
    }

    if (pathname === `${api}/snapshot` && method === "GET") {
      const pid = Number(params.get("pid"));
      const captureId = params.get("capture") ?? "";
      const id = params.get("id") ?? "";
      const agent = deps.readAgents(udid).find((r) => r.pid === pid);
      if (!agent || !/^[\w-]{1,64}$/.test(captureId) || !/^0x[0-9a-f]{1,16}$/i.test(id)) {
        sendJson(res, 404, { error: "not_found" });
        return true;
      }
      try {
        const upstream = await deps.agentGet(agent, `/snapshot/${captureId}/${id}.png`);
        if (upstream.status !== 200) {
          sendJson(res, 404, { error: "not_found" });
          return true;
        }
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=300" });
        res.end(upstream.body);
      } catch (err) {
        sendJson(res, 502, { error: "agent_unreachable", message: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (pathname === `${api}/screenshot` && method === "GET") {
      try {
        const png = await deps.screenshot(udid);
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        res.end(png);
      } catch (err) {
        sendJson(res, 502, { error: "screenshot_failed", message: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (pathname === `${api}/inject` && method === "POST") {
      if (!trustedLoopback) {
        sendJson(res, 403, { error: "forbidden", message: "Relaunching apps is only allowed from this machine." });
        return true;
      }
      let bundleId = "";
      try {
        const body = (await readJsonBody(req)) as { bundleId?: unknown };
        bundleId = typeof body?.bundleId === "string" ? body.bundleId : "";
      } catch {}
      if (!isValidBundleId(bundleId)) {
        sendJson(res, 400, { error: "invalid_bundle_id" });
        return true;
      }
      try {
        const { pid } = await deps.launchWithAgent(udid, bundleId);
        const agent = await deps.waitForAgent(udid, pid);
        sendJson(res, agent ? 200 : 504, agent
          ? { ok: true, pid: agent.pid, bundleId }
          : { error: "agent_timeout", message: `${bundleId} relaunched but the inspector agent didn't register.` });
      } catch (err) {
        sendJson(res, 500, { error: "launch_failed", message: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    sendJson(res, 404, { error: "not_found" });
    return true;
  };
}
