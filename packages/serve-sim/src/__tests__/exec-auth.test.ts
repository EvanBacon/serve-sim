import { describe, expect, test } from "bun:test";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { simMiddleware } from "../middleware";

async function withServer<T>(fn: (origin: string) => Promise<T>): Promise<T> {
  const TOKEN = "test-token-abc123";
  const handler = simMiddleware({ basePath: "/", execToken: TOKEN });
  const server = createServer((req, res) => {
    handler(req, res, async () => {
      if (!res.headersSent) res.statusCode = 404;
      res.end("Not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    return await fn(origin);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const TOKEN = "test-token-abc123";

describe("/exec auth", () => {
  test("rejects unauthenticated POST", async () => {
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ command: "echo hi" }),
      });
      expect(r.status).toBe(401);
    });
  });

  test("rejects non-JSON Content-Type (CSRF-simple-POST path)", async () => {
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/exec`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", Authorization: `Bearer ${TOKEN}`, Origin: origin },
        body: JSON.stringify({ command: "echo hi" }),
      });
      expect(r.status).toBe(415);
    });
  });

  test("rejects cross-origin POST", async () => {
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/exec`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          Origin: "http://evil.example",
        },
        body: JSON.stringify({ command: "echo hi" }),
      });
      expect(r.status).toBe(403);
    });
  });

  test("rejects wrong bearer token", async () => {
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-token", Origin: origin },
        body: JSON.stringify({ command: "echo hi" }),
      });
      expect(r.status).toBe(401);
    });
  });

  test("rejects a POST without Origin even with the exec token", async () => {
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ command: "echo hi" }),
      });
      expect(r.status).toBe(403);
    });
  });

  test("rejects proxied requests even with the exec token and a matching Origin", async () => {
    await withServer(async (origin) => {
      for (const header of ["X-Forwarded-For", "Forwarded", "X-Real-IP", "Tailscale-User-Login"]) {
        const r = await fetch(`${origin}/exec`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
            Origin: origin,
            [header]: "203.0.113.7",
          },
          body: JSON.stringify({ command: "echo hi" }),
        });
        expect(r.status).toBe(403);
      }
    });
  });

  test("accepts same-origin POST with bearer token", async () => {
    await withServer(async (origin) => {
      const r = await fetch(`${origin}/exec`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          Origin: origin,
        },
        body: JSON.stringify({ command: "echo serve-sim-test" }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as { stdout: string; exitCode: number };
      expect(body.stdout.trim()).toBe("serve-sim-test");
      expect(body.exitCode).toBe(0);
    });
  });
});
