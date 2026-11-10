/**
 * HTTP surface for the per-device {@link AxAgent}, mounted next to the raw
 * `/ax` dump under `/helper/<udid>/`:
 *
 *   GET  /ax/snapshot[?all=1]       compact snapshot with @eN refs
 *   POST /ax/act {ref, action?, settle?, timeoutMs?}
 *                                   tap / long-press a ref; with settle, the diff
 *   GET  /ax/settle[?timeoutMs=]    wait for quiet; diff vs the last snapshot
 *
 * HEAD on the GET routes answers 200 without doing any work. More than a few
 * requests in flight per device get 429 (see AxAgent).
 *
 * The middleware's auth gate (token for remote callers, same-origin for
 * non-GET) runs before these, as for every helper route. `act` also requires
 * a JSON body so a cross-site `text/plain` form post can never reach it.
 */
import type { IncomingMessage, ServerResponse } from "http";
import { AxAgentError, type AxAgent } from "./ax-agent";

export type AxAgentEndpoint = "snapshot" | "act" | "settle";

export const AX_AGENT_ENDPOINTS: Record<string, AxAgentEndpoint> = {
  "/ax/snapshot": "snapshot",
  "/ax/act": "act",
  "/ax/settle": "settle",
};

const MAX_BODY_BYTES = 16 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function isJsonContentType(value: string | undefined): boolean {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      if (overflow) return; // drain the rest so the 413 reaches the client
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        reject(new AxAgentError(413, "body_too_large", `Request body over ${MAX_BODY_BYTES} bytes.`));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function serveAxAgent(
  agent: AxAgent,
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: AxAgentEndpoint,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const query = new URL(req.url ?? "", "http://serve-sim.local").searchParams;
  const allowed = endpoint === "act" ? "POST" : "GET";
  if (method !== allowed && !(allowed === "GET" && method === "HEAD")) {
    send(res, 405, { error: "method_not_allowed", message: `Use ${allowed} for /ax/${endpoint}.` }, { Allow: allowed });
    return;
  }
  if (method === "HEAD") {
    // A liveness probe: never read the tree, wait for settle, or touch the
    // ref session. It also doesn't check AX availability (a GET may still
    // answer 503 ax_unavailable), so don't use it as a readiness probe.
    if (!res.writableEnded && !res.destroyed) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end();
    }
    return;
  }
  try {
    if (endpoint === "snapshot") {
      const all = query.get("all");
      send(res, 200, await agent.snapshot({ all: all === "1" || all === "true" }));
    } else if (endpoint === "settle") {
      send(res, 200, await agent.settle({ timeoutMs: query.get("timeoutMs") ?? undefined }));
    } else {
      if (!isJsonContentType(req.headers["content-type"])) {
        throw new AxAgentError(415, "unsupported_media_type", "POST /ax/act needs Content-Type: application/json.");
      }
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new AxAgentError(400, "invalid_request", "Request body is not valid JSON.");
      }
      send(res, 200, await agent.act(body));
    }
  } catch (error) {
    if (error instanceof AxAgentError) {
      send(res, error.status, error.toJSON());
      return;
    }
    send(res, 500, { error: "ax_agent_failed", message: error instanceof Error ? error.message : String(error) });
  }
}
