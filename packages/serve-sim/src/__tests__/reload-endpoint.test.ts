import { describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "http";
import type { AddressInfo } from "net";
import { simMiddleware } from "../middleware";

async function postReload(body: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const middleware = simMiddleware({ basePath: "/", proxyHelpers: true });
  const server = createHttpServer((req, res) => {
    void middleware(req, res, async () => {
      res.writeHead(404);
      res.end("Not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("POST /reload", () => {
  test("Expo Go is reported as not sent before any device lookup", async () => {
    expect(await postReload(JSON.stringify({ bundleId: "host.exp.Exponent" }))).toEqual({
      status: 200,
      json: { sent: false, reason: "unsupported-app", confirmed: false },
    });
  });

  test("a missing bundle id sends nothing", async () => {
    const { status, json } = await postReload("{}");
    expect(status).toBe(200);
    expect(json.sent).toBe(false);
  });

  test("malformed bodies send nothing", async () => {
    const { status, json } = await postReload("{");
    expect(status).toBe(400);
    expect(json.sent).toBe(false);
  });
});
