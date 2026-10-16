import { describe, expect, test } from "bun:test";
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "net";
import { proxyTcpToHttpServer } from "../runtime";

// The Bun front server pipes plain HTTP to an internal loopback server and
// records the real peer by the pipe's local port. If that port is unknown the
// request would look like loopback, so the pipe must be torn down instead.

function listen(onConnection: (socket: Socket) => void): Promise<Server> {
  const server = createServer(onConnection);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A connected client/server socket pair standing in for the browser's TCP connection. */
async function clientPair(): Promise<{ client: Socket; accepted: Socket; server: Server }> {
  const { promise: acceptedSocket, resolve } = Promise.withResolvers<Socket>();
  const server = await listen(resolve);
  const client = createConnection((server.address() as AddressInfo).port, "127.0.0.1");
  return { client, accepted: await acceptedSocket, server };
}

describe("proxyTcpToHttpServer", () => {
  test("fails closed when the upstream local port is unavailable", async () => {
    const received: Buffer[] = [];
    const internal = await listen((s) => s.on("data", (d: Buffer) => received.push(d)));
    const internalPort = (internal.address() as AddressInfo).port;
    const { client, accepted, server } = await clientPair();

    const clientClosed = new Promise<void>((r) => client.once("close", () => r()));
    proxyTcpToHttpServer(accepted, Buffer.from("GET / HTTP/1.1\r\n\r\n"), internalPort, (port) => {
      const upstream = createConnection(port, "127.0.0.1");
      Object.defineProperty(upstream, "localPort", { get: () => undefined });
      return upstream;
    });

    await clientClosed;
    await Bun.sleep(50);
    expect(accepted.destroyed).toBe(true);
    expect(received).toEqual([]);
    client.destroy();
    await Promise.all([close(internal), close(server)]);
  });

  test("forwards the request when the peer is registered", async () => {
    const received: Buffer[] = [];
    const internal = await listen((s) => s.on("data", (d: Buffer) => received.push(d)));
    const internalPort = (internal.address() as AddressInfo).port;
    const { client, accepted, server } = await clientPair();

    proxyTcpToHttpServer(accepted, Buffer.from("GET / HTTP/1.1\r\n\r\n"), internalPort);

    for (let i = 0; i < 50 && received.length === 0; i++) await Bun.sleep(10);
    expect(Buffer.concat(received).toString()).toBe("GET / HTTP/1.1\r\n\r\n");
    client.destroy();
    accepted.destroy();
    await Promise.all([close(internal), close(server)]);
  });
});
