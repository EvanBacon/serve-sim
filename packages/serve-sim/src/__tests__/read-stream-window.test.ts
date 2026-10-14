import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { readStreamWindow } from "./read-stream-window";

/**
 * Regression for the idle-floor CI failure: a stream that stalls across the
 * read deadline used to abort the fetch mid-read, and the unawaited
 * `reader.cancel()` that followed rejected with an AbortError nobody handled
 * ("Unhandled error between tests" after both tests passed).
 */

let server: Server | undefined;

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

async function serve(handler: (res: ServerResponse) => void): Promise<string> {
  server = createServer((_req, res) => handler(res));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

async function unhandledRejectionsDuring(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => { seen.push(reason); };
  process.on("unhandledRejection", onRejection);
  try {
    await run();
    // Give a dangling cancel()/read() rejection time to surface.
    await Bun.sleep(100);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}

describe("readStreamWindow", () => {
  test("a stream that stalls past the deadline ends cleanly with no unhandled rejection", async () => {
    const url = await serve((res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write("first");
      // Then stall: no more bytes and no end, like a frozen frame source.
    });
    const chunks: string[] = [];
    let result: Awaited<ReturnType<typeof readStreamWindow>> | undefined;
    const t0 = Date.now();

    const rejections = await unhandledRejectionsDuring(async () => {
      result = await readStreamWindow(url, 200, (chunk) => { chunks.push(Buffer.from(chunk).toString()); });
    });

    expect(rejections).toEqual([]);
    expect(result?.ended).toBe("deadline");
    expect(result?.response.status).toBe(200);
    expect(chunks.join("")).toBe("first");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("stops when the chunk callback returns true", async () => {
    const url = await serve((res) => {
      res.writeHead(200);
      res.write("a");
    });
    const rejections = await unhandledRejectionsDuring(async () => {
      const result = await readStreamWindow(url, 5000, () => true);
      expect(result.ended).toBe("stopped");
    });
    expect(rejections).toEqual([]);
  });

  test("reports a server-closed stream as done", async () => {
    const url = await serve((res) => {
      res.writeHead(200);
      res.end("bye");
    });
    const rejections = await unhandledRejectionsDuring(async () => {
      const result = await readStreamWindow(url, 5000, () => {});
      expect(result.ended).toBe("done");
    });
    expect(rejections).toEqual([]);
  });
});
