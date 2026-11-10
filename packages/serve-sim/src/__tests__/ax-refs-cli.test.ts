import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import {
  AxCliError,
  axAgentUrlForWsUrl,
  formatAgentSnapshotText,
  parseTapTarget,
  parseTimeoutOption,
  requestAxAgent,
} from "../ax-cli";

describe("parseTapTarget", () => {
  test("a first argument starting with @ is a ref", () => {
    expect(parseTapTarget("@e2", undefined)).toEqual({ kind: "ref", ref: "@e2" });
    expect(parseTapTarget("@E12", undefined)).toEqual({ kind: "ref", ref: "@e12" });
  });

  test("numeric coordinates keep the existing tap path (validated there)", () => {
    expect(parseTapTarget("0.5", "0.9")).toEqual({ kind: "point", x: "0.5", y: "0.9" });
    // Out-of-range or missing y still goes to the coordinate path, whose
    // usage error is unchanged.
    expect(parseTapTarget("2", "0.5")).toEqual({ kind: "point", x: "2", y: "0.5" });
    expect(parseTapTarget("0.5", undefined)).toEqual({ kind: "point", x: "0.5", y: undefined });
  });

  test("rejects malformed refs and a ref followed by a coordinate", () => {
    expect(parseTapTarget("@general", undefined)).toMatchObject({ kind: "error" });
    expect(parseTapTarget("@e0", undefined)).toMatchObject({ kind: "error" });
    const extra = parseTapTarget("@e2", "0.5");
    expect(extra).toMatchObject({ kind: "error" });
    if (extra.kind === "error") expect(extra.message).toContain("@e2");
  });
});

describe("parseTimeoutOption", () => {
  test("accepts non-negative milliseconds", () => {
    expect(parseTimeoutOption(undefined)).toBeUndefined();
    expect(parseTimeoutOption("1500")).toBe(1500);
    expect(parseTimeoutOption("0")).toBe(0);
  });

  test("rejects junk and negatives", () => {
    expect(() => parseTimeoutOption("soon")).toThrow("--timeout");
    expect(() => parseTimeoutOption("-1")).toThrow("--timeout");
    expect(() => parseTimeoutOption("")).toThrow("--timeout");
  });
});

describe("axAgentUrlForWsUrl", () => {
  test("maps the HID socket URL to the sibling /ax/* endpoints", () => {
    expect(axAgentUrlForWsUrl("ws://127.0.0.1:3411/helper/UDID/ws", "snapshot"))
      .toBe("http://127.0.0.1:3411/helper/UDID/ax/snapshot");
    expect(axAgentUrlForWsUrl("wss://tunnel.example/base/helper/UDID/ws", "act"))
      .toBe("https://tunnel.example/base/helper/UDID/ax/act");
    expect(axAgentUrlForWsUrl("ws://127.0.0.1:3411/helper/UDID/ws", "snapshot", { all: "1" }))
      .toBe("http://127.0.0.1:3411/helper/UDID/ax/snapshot?all=1");
  });

  test("returns null for URLs that are not a helper socket", () => {
    expect(axAgentUrlForWsUrl("not a url", "settle")).toBeNull();
    expect(axAgentUrlForWsUrl("ws://127.0.0.1:3411/other", "settle")).toBeNull();
  });
});

describe("formatAgentSnapshotText", () => {
  test("one line per node with ref, role, label, value and frame", () => {
    const text = formatAgentSnapshotText({
      screen: { width: 402, height: 874 },
      nodes: [
        { ref: "@e1", role: "heading", type: "Heading", label: "Settings", frame: { x: 16, y: 60, w: 200, h: 40 }, center: { x: 116, y: 80 } },
        { ref: "@e2", role: "switch", type: "CheckBox", label: "Wi-Fi", value: "1", enabled: false, frame: { x: 0, y: 300, w: 402, h: 52 }, center: { x: 201, y: 326 } },
      ],
    });
    expect(text).toBe([
      "screen 402x874",
      '@e1 heading "Settings" (16,60 200x40)',
      '@e2 switch "Wi-Fi" = "1" disabled (0,300 402x52)',
    ].join("\n"));
  });
});

describe("requestAxAgent", () => {
  let server: Server;
  let base: string;
  let lastHeaders: IncomingHttpHeaders = {};
  let lastBody = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastHeaders = req.headers;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastBody = body;
        if (req.url === "/ok") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else if (req.url === "/stale") {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "stale_ref", message: "@e2 is stale: gone. Run `serve-sim ax --refs`." }));
        } else {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("bad gateway");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  test("GETs JSON with the target's auth headers", async () => {
    expect(await requestAxAgent(`${base}/ok`, { headers: { Authorization: "Bearer t" } })).toEqual({ ok: true });
    expect(lastHeaders.authorization).toBe("Bearer t");
  });

  test("POSTs a JSON body when given one", async () => {
    await requestAxAgent(`${base}/ok`, { headers: {}, body: { ref: "@e2", settle: true } });
    expect(lastHeaders["content-type"]).toBe("application/json");
    expect(JSON.parse(lastBody)).toEqual({ ref: "@e2", settle: true });
  });

  test("surfaces the server's error code and message", async () => {
    try {
      await requestAxAgent(`${base}/stale`, { headers: {} });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AxCliError);
      expect(error).toMatchObject({ status: 409, code: "stale_ref" });
      expect((error as Error).message).toContain("@e2 is stale");
    }
  });

  test("non-JSON errors still fail with the HTTP status", async () => {
    await expect(requestAxAgent(`${base}/other`, { headers: {} })).rejects.toThrow("HTTP 502");
  });
});
