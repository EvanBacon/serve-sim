import { spawn, type ChildProcess } from "child_process";

export interface Tunnel {
  /** Public URL (e.g. https://random-words.trycloudflare.com). */
  url: string;
  /** PID of the cloudflared child process. */
  pid: number;
  /** Underlying child process — useful for piping logs in dev. */
  child: ChildProcess;
  /** Best-effort terminate. Safe to call multiple times. */
  stop(): void;
}

export type TunnelProtocol = "auto" | "quic" | "http2";

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const DEFAULT_TIMEOUT_MS = 30_000;

const NOT_FOUND_HINT =
  "cloudflared not found on PATH. Install it with `brew install cloudflared` " +
  "(macOS) or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/.";

/**
 * Spawn a cloudflared "quick tunnel" for `http://localhost:<port>` and resolve
 * once the public trycloudflare.com URL has been printed. The child process
 * keeps running — call `tunnel.stop()` to terminate it.
 */
export function startCloudflareTunnel(
  port: number,
  opts?: { timeoutMs?: number; protocol?: TunnelProtocol },
): Promise<Tunnel> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const protocol = opts?.protocol;

  return new Promise<Tunnel>((resolve, reject) => {
    let child: ChildProcess;
    const args = [
      "tunnel",
      "--no-autoupdate",
      ...(protocol ? ["--protocol", protocol] : []),
      "--url",
      `http://localhost:${port}`,
    ];
    try {
      child = spawn(
        "cloudflared",
        args,
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(NOT_FOUND_HINT));
      } else {
        reject(err);
      }
      return;
    }

    let resolved = false;
    let buffer = "";

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString();
      // Bound the buffer so we don't grow unbounded if cloudflared chats a lot
      // before printing the URL.
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-32 * 1024);
      const match = buffer.match(TRYCLOUDFLARE_RE);
      if (match && !resolved) {
        resolved = true;
        cleanup();
        resolve({
          url: match[0],
          pid: child.pid!,
          child,
          stop: () => {
            try { child.kill("SIGTERM"); } catch {}
          },
        });
      }
    };

    const onError = (err: NodeJS.ErrnoException) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try { child.kill(); } catch {}
      reject(err.code === "ENOENT" ? new Error(NOT_FOUND_HINT) : err);
    };

    const onExit = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const tail = buffer.split("\n").slice(-5).join("\n").trim();
      reject(
        new Error(
          `cloudflared exited (code ${code}) before producing a URL` +
            (tail ? `:\n${tail}` : ""),
        ),
      );
    };

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try { child.kill(); } catch {}
      reject(new Error(`cloudflared did not produce a URL within ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}
