import { afterEach, describe, expect, test } from "bun:test";
import { fetchGatewayStatus } from "../discovery";

describe("fetchGatewayStatus", () => {
  let mockServer: ReturnType<typeof Bun.serve>;

  afterEach(() => {
    if (mockServer) mockServer.stop();
  });

  test("returns status when server responds correctly", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/status") {
          return Response.json({
            ok: true,
            version: "2.0.0",
            sessions: 3,
            maxSessions: 64,
            allowlist: ["echo *", "ls *"],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const status = await fetchGatewayStatus({
      baseUrl: `http://localhost:${mockServer.port}`,
    });

    expect(status).not.toBeNull();
    expect(status!.ok).toBe(true);
    expect(status!.version).toBe("2.0.0");
    expect(status!.sessions).toBe(3);
    expect(status!.maxSessions).toBe(64);
    expect(status!.allowlist).toEqual(["echo *", "ls *"]);
  });

  test("returns null when server returns non-200", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    const status = await fetchGatewayStatus({
      baseUrl: `http://localhost:${mockServer.port}`,
    });
    expect(status).toBeNull();
  });

  test("returns null when response body lacks 'ok' field", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/status") {
          return Response.json({ version: "1.0.0" }); // missing 'ok'
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const status = await fetchGatewayStatus({
      baseUrl: `http://localhost:${mockServer.port}`,
    });
    expect(status).toBeNull();
  });

  test("returns null when server is unreachable", async () => {
    const status = await fetchGatewayStatus({
      baseUrl: "http://localhost:1",
      timeout: 100,
    });
    expect(status).toBeNull();
  });

  test("strips trailing slash from baseUrl", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        // Ensure path is /status, not //status
        if (url.pathname === "/status") {
          return Response.json({
            ok: true,
            version: null,
            sessions: 0,
            maxSessions: 64,
            allowlist: [],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const status = await fetchGatewayStatus({
      baseUrl: `http://localhost:${mockServer.port}/`,
    });
    expect(status).not.toBeNull();
    expect(status!.ok).toBe(true);
  });

  test("uses default baseUrl and timeout", async () => {
    // This will fail to connect (nothing on default port), returning null
    const status = await fetchGatewayStatus();
    // Can't guarantee default port is free, but function should not throw
    expect(status === null || (status && typeof status.ok === "boolean")).toBe(
      true
    );
  });

  test("returns null on timeout", async () => {
    // Start a server that never responds
    mockServer = Bun.serve({
      port: 0,
      async fetch() {
        // Delay longer than the timeout
        await new Promise((r) => setTimeout(r, 5000));
        return new Response("too late");
      },
    });

    const status = await fetchGatewayStatus({
      baseUrl: `http://localhost:${mockServer.port}`,
      timeout: 50,
    });
    expect(status).toBeNull();
  });

  test("returns null when response is not valid JSON", async () => {
    mockServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/status") {
          return new Response("not json", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const status = await fetchGatewayStatus({
      baseUrl: `http://localhost:${mockServer.port}`,
    });
    expect(status).toBeNull();
  });
});
