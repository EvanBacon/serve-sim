import { describe, expect, test } from "bun:test";
import { createServer, request } from "http";
import type { AddressInfo } from "net";
import { simMiddleware } from "../middleware";
import {
  PASTEBOARD_TEXT_LIMIT_BYTES,
  PASTE_KEY_EVENTS,
  pasteboardArgs,
  stagePasteboardText,
  type DevicectlRunner,
} from "../pasteboard";
import { textToKeyEvents, UnsupportedCharacterError } from "../text-to-keys";

// #174: Unicode text reaches the guest through the CoreDevice pasteboard
// (`devicectl device pasteboard copy`, verified by `paste` readback), not HID
// keys, which only cover US-keyboard ASCII.

delete process.env.SERVE_SIM_AUTH_TOKEN;

const UDID = "2DD68D49-7354-48AC-A4AF-C6B4462BF6B7";
const OTHER_UDID = "B6F7948E-2C66-46D9-A2A9-52509E37F81D";
const AUTH_TOKEN = "pasteboard-auth-token-for-tests";
// The reporter's payload: Cyrillic (precomposed and with a combining
// diaeresis) plus a ZWJ emoji sequence.
const REPORTER_PAYLOAD = "Bridge123 ёж ёж \u{1F469}‍\u{1F373}";
const SHELL_METACHARS = `a$(touch /tmp/pwn)\`id\`;|&>"'\\ \n*?~ !$HOME`;

interface Call { args: string[]; stdin: Buffer | null }

/** A fake devicectl whose pasteboard round-trips copy → paste unless told otherwise. */
function fakeDevicectl(opts: {
  copyCode?: number;
  pasteCode?: number;
  /** Bytes `paste` prints instead of what was copied (a stale clipboard). */
  readback?: Buffer;
} = {}): { run: DevicectlRunner; calls: Call[] } {
  const calls: Call[] = [];
  let board = Buffer.from("stale clipboard");
  const run: DevicectlRunner = async (args, stdin) => {
    calls.push({ args: [...args], stdin });
    const verb = args[2];
    if (verb === "copy") {
      if (opts.copyCode) return { code: opts.copyCode, stdout: Buffer.alloc(0), stderr: "ERROR: copy failed" };
      board = Buffer.from(stdin ?? Buffer.alloc(0));
      return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
    }
    if (verb === "paste") {
      if (opts.pasteCode) return { code: opts.pasteCode, stdout: Buffer.alloc(0), stderr: "ERROR: paste failed" };
      return { code: 0, stdout: opts.readback ?? board, stderr: "" };
    }
    return { code: 64, stdout: Buffer.alloc(0), stderr: "unknown verb" };
  };
  return { run, calls };
}

describe("HID typing gap (regression context)", () => {
  test("`type` keys stay ASCII-only; Unicode needs the pasteboard bridge", () => {
    expect(textToKeyEvents("Hello, world!").length).toBeGreaterThan(0);
    expect(() => textToKeyEvents(REPORTER_PAYLOAD)).toThrow(UnsupportedCharacterError);
  });
});

describe("stagePasteboardText", () => {
  test("passes the text only on stdin with fixed argv, then verifies readback", async () => {
    const { run, calls } = fakeDevicectl();
    const result = await stagePasteboardText(UDID, SHELL_METACHARS, run);
    expect(result).toEqual({ ok: true, bytes: Buffer.byteLength(SHELL_METACHARS) });
    expect(calls.map((c) => c.args)).toEqual([pasteboardArgs("copy", UDID), pasteboardArgs("paste", UDID)]);
    expect(pasteboardArgs("copy", UDID)).toEqual([
      "device", "pasteboard", "copy", "--device", UDID, "--timeout", "10", "--quiet",
    ]);
    expect(calls[0]!.stdin!.equals(Buffer.from(SHELL_METACHARS, "utf8"))).toBe(true);
    for (const c of calls) expect(c.args.join(" ")).not.toContain("touch");
  });

  test("the reporter payload round-trips byte for byte", async () => {
    const { run, calls } = fakeDevicectl();
    expect(await stagePasteboardText(UDID, REPORTER_PAYLOAD, run)).toEqual({
      ok: true,
      bytes: Buffer.byteLength(REPORTER_PAYLOAD),
    });
    expect(calls[0]!.stdin!.toString("utf8")).toBe(REPORTER_PAYLOAD);
  });

  test("a failed copy is an error and skips the readback", async () => {
    const { run, calls } = fakeDevicectl({ copyCode: 1 });
    const result = await stagePasteboardText(UDID, "hi", run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("copy_failed");
    expect(calls).toHaveLength(1);
  });

  test("a failed readback is an error", async () => {
    const { run } = fakeDevicectl({ pasteCode: 1 });
    const result = await stagePasteboardText(UDID, "hi", run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("readback_failed");
  });

  test("copy exit 0 with a stale clipboard is rejected, not reported as success", async () => {
    const { run } = fakeDevicectl({ readback: Buffer.from("stale clipboard") });
    const result = await stagePasteboardText(UDID, REPORTER_PAYLOAD, run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("readback_mismatch");
  });

  test("near-miss readback (precomposed vs combining, trailing newline) is rejected", async () => {
    for (const readback of [
      Buffer.from(REPORTER_PAYLOAD.normalize("NFC")),
      Buffer.from(REPORTER_PAYLOAD + "\n"),
    ]) {
      const { run } = fakeDevicectl({ readback });
      const result = await stagePasteboardText(UDID, REPORTER_PAYLOAD, run);
      expect(result.ok).toBe(false);
    }
  });

  test("a runner that throws (e.g. no xcrun) is an error", async () => {
    const result = await stagePasteboardText(UDID, "hi", async () => {
      throw new Error("spawn xcrun ENOENT");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("copy_failed");
  });

  test("rejects a malformed UDID before spawning anything", async () => {
    const { run, calls } = fakeDevicectl();
    for (const bad of ["", "booted", "--help", `${UDID} --foo`, "iPhone 18 Pro"]) {
      const result = await stagePasteboardText(bad, "hi", run);
      expect(result.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Cmd+V follow-up", () => {
  test("is Left-GUI + V, released in reverse order", () => {
    expect(PASTE_KEY_EVENTS).toEqual([
      { type: "down", usage: 0xe3 },
      { type: "down", usage: 0x19 },
      { type: "up", usage: 0x19 },
      { type: "up", usage: 0xe3 },
    ]);
  });
});

interface Res { status: number; json: Record<string, unknown> }
const CONNECTION_CUT = -1;

async function withServer(
  opts: { run: DevicectlRunner; served?: string[]; authToken?: string },
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const served = new Set(opts.served ?? [UDID]);
  const middleware = simMiddleware({
    basePath: "/",
    authToken: opts.authToken,
    pasteboardRunner: opts.run,
    servesDevice: async (udid) => served.has(udid),
  });
  const server = createServer((req, res) => {
    void middleware(req, res, async () => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function post(
  port: number,
  path: string,
  body: string | Buffer,
  headers: Record<string, string> = { "Content-Type": "application/json" },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    // The server may answer 413 and cut the connection before the whole
    // body is written; the client then sees a reset instead of the reply.
    req.on("error", (err) => ["ECONNRESET", "EPIPE"].includes((err as NodeJS.ErrnoException).code ?? "")
      ? resolve({ status: CONNECTION_CUT, json: {} })
      : reject(err));
    req.end(body);
  });
}

const path = (udid = UDID) => `/pasteboard?device=${encodeURIComponent(udid)}`;

describe("POST /pasteboard", () => {
  test("stages the reporter payload and reports verified success", async () => {
    const { run, calls } = fakeDevicectl();
    await withServer({ run }, async (port) => {
      const res = await post(port, path(), JSON.stringify({ text: REPORTER_PAYLOAD }));
      expect(res).toEqual({
        status: 200,
        json: { ok: true, verified: true, bytes: Buffer.byteLength(REPORTER_PAYLOAD) },
      });
      expect(calls[0]!.stdin!.toString("utf8")).toBe(REPORTER_PAYLOAD);
      expect(calls[0]!.args).toEqual(pasteboardArgs("copy", UDID));
    });
  });

  test("shell metacharacters are data, never argv", async () => {
    const { run, calls } = fakeDevicectl();
    await withServer({ run }, async (port) => {
      const res = await post(port, path(), JSON.stringify({ text: SHELL_METACHARS }));
      expect(res.status).toBe(200);
      expect(calls[0]!.stdin!.toString("utf8")).toBe(SHELL_METACHARS);
      for (const c of calls) expect(c.args).not.toContain(SHELL_METACHARS);
    });
  });

  test("a stale readback answers 502 with ok:false", async () => {
    const { run } = fakeDevicectl({ readback: Buffer.from("old") });
    await withServer({ run }, async (port) => {
      const res = await post(port, path(), JSON.stringify({ text: "new" }));
      expect(res.status).toBe(502);
      expect(res.json).toMatchObject({ ok: false, error: "readback_mismatch" });
    });
  });

  test("a failed copy answers 502 with ok:false", async () => {
    const { run } = fakeDevicectl({ copyCode: 1 });
    await withServer({ run }, async (port) => {
      const res = await post(port, path(), JSON.stringify({ text: "new" }));
      expect(res.status).toBe(502);
      expect(res.json).toMatchObject({ ok: false, error: "copy_failed" });
    });
  });

  test("requires a well-formed UDID that this server serves", async () => {
    const { run, calls } = fakeDevicectl();
    await withServer({ run }, async (port) => {
      expect((await post(port, "/pasteboard", JSON.stringify({ text: "x" }))).status).toBe(400);
      expect((await post(port, path("booted"), JSON.stringify({ text: "x" }))).status).toBe(400);
      expect((await post(port, path("--help"), JSON.stringify({ text: "x" }))).status).toBe(400);
      const other = await post(port, path(OTHER_UDID), JSON.stringify({ text: "x" }));
      expect(other.status).toBe(404);
      expect(other.json).toMatchObject({ ok: false, error: "unknown_device" });
    });
    expect(calls).toHaveLength(0);
  });

  test("rejects missing, empty, non-string, and ill-formed text", async () => {
    const { run, calls } = fakeDevicectl();
    await withServer({ run }, async (port) => {
      for (const body of ["{", "{}", '{"text":""}', '{"text":42}', '{"text":"\\ud800"}']) {
        const res = await post(port, path(), body);
        expect(res.status).toBe(400);
        expect(res.json.ok).toBe(false);
      }
    });
    expect(calls).toHaveLength(0);
  });

  test("requires a JSON content type (no text/plain form posts)", async () => {
    const { run, calls } = fakeDevicectl();
    await withServer({ run }, async (port) => {
      const res = await post(port, path(), JSON.stringify({ text: "x" }), { "Content-Type": "text/plain" });
      expect(res.status).toBe(415);
    });
    expect(calls).toHaveLength(0);
  });

  test(`accepts exactly ${PASTEBOARD_TEXT_LIMIT_BYTES} UTF-8 bytes and rejects one more`, async () => {
    expect(PASTEBOARD_TEXT_LIMIT_BYTES).toBe(256 * 1024);
    const { run, calls } = fakeDevicectl();
    await withServer({ run }, async (port) => {
      // 3-byte characters, so a character count would under-measure.
      const atLimit = "€".repeat(PASTEBOARD_TEXT_LIMIT_BYTES / 4) + "a".repeat(PASTEBOARD_TEXT_LIMIT_BYTES / 4);
      expect(Buffer.byteLength(atLimit)).toBe(PASTEBOARD_TEXT_LIMIT_BYTES);
      expect((await post(port, path(), JSON.stringify({ text: atLimit }))).status).toBe(200);
      const over = await post(port, path(), JSON.stringify({ text: atLimit + "a" }));
      expect(over.status).toBe(413);
      expect(calls).toHaveLength(2);
      // A body far over the cap is cut off without buffering it all.
      const huge = await post(port, path(), JSON.stringify({ text: "a".repeat(8 * 1024 * 1024) }));
      expect([413, CONNECTION_CUT]).toContain(huge.status);
    });
    expect(calls).toHaveLength(2);
  });

  test("an unauthenticated remote caller is rejected before devicectl runs", async () => {
    const { run, calls } = fakeDevicectl();
    await withServer({ run, authToken: AUTH_TOKEN }, async (port) => {
      const remote = { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7" };
      const denied = await post(port, path(), JSON.stringify({ text: "x" }), remote);
      expect(denied.status).toBe(401);
      const wrong = await post(port, path(), JSON.stringify({ text: "x" }), { ...remote, Authorization: "Bearer nope" });
      expect(wrong.status).toBe(401);
      expect(calls).toHaveLength(0);
      const ok = await post(port, path(), JSON.stringify({ text: "x" }), { ...remote, Authorization: `Bearer ${AUTH_TOKEN}` });
      expect(ok.status).toBe(200);
    });
  });

  test("remote access stays off without a server auth token", async () => {
    const { run, calls } = fakeDevicectl();
    await withServer({ run }, async (port) => {
      const res = await post(port, path(), JSON.stringify({ text: "x" }), {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.7",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      });
      expect(res.status).toBe(403);
    });
    expect(calls).toHaveLength(0);
  });

  test("a cross-origin browser POST is blocked", async () => {
    const { run, calls } = fakeDevicectl();
    await withServer({ run }, async (port) => {
      const res = await post(port, path(), JSON.stringify({ text: "x" }), {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      });
      expect(res.status).toBe(403);
    });
    expect(calls).toHaveLength(0);
  });
});
