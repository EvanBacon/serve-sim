import { spawn } from "child_process";
import type { IncomingMessage, ServerResponse } from "http";
import { PASTEBOARD_TEXT_LIMIT_BYTES } from "./pasteboard-shared";

export { PASTEBOARD_TEXT_LIMIT_BYTES, PASTE_KEY_EVENTS } from "./pasteboard-shared";

/**
 * Unicode text bridge (#174). HID key events (`serve-sim type`, browser
 * keydown forwarding) only cover the US keyboard, so arbitrary text goes
 * through the guest pasteboard instead:
 *
 *   xcrun devicectl device pasteboard copy  --device <udid> --timeout 10 --quiet  (text on stdin)
 *   xcrun devicectl device pasteboard paste --device <udid> --timeout 10 --quiet  (readback)
 *
 * The text is never part of any argv or shell string. Success is reported
 * only when the readback is byte-for-byte the UTF-8 that was copied: a copy
 * command exiting 0 is not proof (`simctl pbcopy` has been seen to exit 0 and
 * leave the guest clipboard stale on iOS 27).
 *
 * This only stages the clipboard. Inserting it into the focused guest field
 * is a separate Cmd+V HID chord (`PASTE_KEY_EVENTS`) the client sends after a
 * verified stage.
 */

/**
 * Largest request body. JSON escaping can grow text up to 6x (`\u0000`), so
 * the raw cap is looser; the decoded text is then held to the limit above.
 */
const PASTEBOARD_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

const DEVICECTL_TIMEOUT_SECONDS = 10;
/** Kill a wedged devicectl a little after its own --timeout. */
const RUNNER_KILL_MS = (DEVICECTL_TIMEOUT_SECONDS + 5) * 1000;

const UDID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

function isSimulatorUdid(value: unknown): value is string {
  return typeof value === "string" && UDID_RE.test(value);
}

interface DevicectlResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Runs `xcrun devicectl <args>` with optional stdin. Injected in tests. */
export type DevicectlRunner = (args: readonly string[], stdin: Buffer | null) => Promise<DevicectlResult>;

/** @lintignore Exported for tests. */
export function pasteboardArgs(verb: "copy" | "paste", udid: string): string[] {
  return [
    "device", "pasteboard", verb,
    "--device", udid,
    "--timeout", String(DEVICECTL_TIMEOUT_SECONDS),
    "--quiet",
  ];
}

const runDevicectl: DevicectlRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn("xcrun", ["devicectl", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), RUNNER_KILL_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      // Readback only needs to be one byte longer than the limit to mismatch.
      if (outBytes > PASTEBOARD_TEXT_LIMIT_BYTES) return;
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? undefined);
  });

export type StageResult =
  | { ok: true; bytes: number }
  | {
      ok: false;
      error: "invalid_device" | "copy_failed" | "readback_failed" | "readback_mismatch";
      detail?: string;
    };

function failureDetail(result: DevicectlResult | Error): string {
  if (result instanceof Error) return result.message;
  const stderr = result.stderr.trim();
  return stderr ? stderr.slice(0, 500) : `devicectl exited ${result.code}`;
}

// One stage at a time per device, so two concurrent requests can't read
// back each other's copy.
const deviceQueues = new Map<string, Promise<unknown>>();

function serialized<T>(udid: string, task: () => Promise<T>): Promise<T> {
  const previous = deviceQueues.get(udid) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => {});
  deviceQueues.set(udid, settled);
  void settled.then(() => {
    if (deviceQueues.get(udid) === settled) deviceQueues.delete(udid);
  });
  return next;
}

/**
 * Copy `text` to the guest pasteboard and confirm it by exact readback.
 * @lintignore Exported for tests.
 */
export function stagePasteboardText(
  udid: string,
  text: string,
  run: DevicectlRunner = runDevicectl,
): Promise<StageResult> {
  if (!isSimulatorUdid(udid)) return Promise.resolve({ ok: false, error: "invalid_device" });
  const bytes = Buffer.from(text, "utf8");
  return serialized(udid, async (): Promise<StageResult> => {
    let copy: DevicectlResult;
    try {
      copy = await run(pasteboardArgs("copy", udid), bytes);
    } catch (err) {
      return { ok: false, error: "copy_failed", detail: failureDetail(err as Error) };
    }
    if (copy.code !== 0) return { ok: false, error: "copy_failed", detail: failureDetail(copy) };
    let paste: DevicectlResult;
    try {
      paste = await run(pasteboardArgs("paste", udid), null);
    } catch (err) {
      return { ok: false, error: "readback_failed", detail: failureDetail(err as Error) };
    }
    if (paste.code !== 0) return { ok: false, error: "readback_failed", detail: failureDetail(paste) };
    if (!paste.stdout.equals(bytes)) {
      return {
        ok: false,
        error: "readback_mismatch",
        detail: `guest pasteboard holds ${paste.stdout.length} bytes, expected ${bytes.length}`,
      };
    }
    return { ok: true, bytes: bytes.length };
  });
}

const LONE_SURROGATE_RE = /\p{Cs}/u;

function isJsonContentType(value: string | undefined): boolean {
  return (value ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

export interface PasteboardRouteOptions {
  run?: DevicectlRunner;
  /** Whether `udid` is a simulator this server streams. */
  servesDevice: (udid: string) => Promise<boolean>;
}

/**
 * `POST {base}/pasteboard?device=<udid>` with `{"text": "..."}`. Auth, the
 * remote-access gate, and the same-origin check run in the middleware before
 * this. Answers `{ok: true, verified: true, bytes}` only after exact readback.
 */
export function createPasteboardRoute(options: PasteboardRouteOptions) {
  const run = options.run ?? runDevicectl;
  return (req: IncomingMessage, res: ServerResponse, device: string | null): void => {
    const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
      res.end(JSON.stringify(body));
    };
    // JSON only: rules out CORS-simple `text/plain` form posts.
    if (!isJsonContentType(req.headers["content-type"])) {
      reply(415, { ok: false, error: "unsupported_media_type" });
      req.resume();
      return;
    }
    if (!isSimulatorUdid(device)) {
      reply(400, { ok: false, error: "invalid_device" });
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      bodyBytes += chunk.length;
      if (bodyBytes > PASTEBOARD_BODY_LIMIT_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reply(413, { ok: false, error: "payload_too_large", limitBytes: PASTEBOARD_TEXT_LIMIT_BYTES }, { Connection: "close" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (tooLarge) return;
      let text: unknown;
      try {
        text = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: unknown } | null)?.text;
      } catch {
        reply(400, { ok: false, error: "invalid_json" });
        return;
      }
      // Lone surrogates would be re-encoded as U+FFFD, silently changing the text.
      if (typeof text !== "string" || text === "" || LONE_SURROGATE_RE.test(text)) {
        reply(400, { ok: false, error: "invalid_text" });
        return;
      }
      if (Buffer.byteLength(text, "utf8") > PASTEBOARD_TEXT_LIMIT_BYTES) {
        reply(413, { ok: false, error: "payload_too_large", limitBytes: PASTEBOARD_TEXT_LIMIT_BYTES });
        return;
      }
      try {
        if (!(await options.servesDevice(device))) {
          reply(404, { ok: false, error: "unknown_device" });
          return;
        }
        const result = await stagePasteboardText(device, text, run);
        if (result.ok) reply(200, { ok: true, verified: true, bytes: result.bytes });
        else reply(502, { ok: false, error: result.error, ...(result.detail ? { detail: result.detail } : {}) });
      } catch (err) {
        reply(500, { ok: false, error: err instanceof Error ? err.message : "pasteboard_failed" });
      }
    });
  };
}
