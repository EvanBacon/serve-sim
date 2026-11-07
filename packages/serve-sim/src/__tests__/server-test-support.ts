import { createServer } from "net";
import { setTimeout as delay } from "timers/promises";

export async function freePort(): Promise<number> {
  const server = createServer();
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const address = server.address();
  const closed = Promise.withResolvers<void>();
  server.close((error) => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  if (!address || typeof address === "string") throw new Error("failed to allocate port");
  return address.port;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1_000, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await delay(intervalMs);
  }
}
