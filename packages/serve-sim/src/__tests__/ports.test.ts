import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { getPortHolders } from "../ports";

// getPortHolders feeds killPortHolder, which SIGKILLs its results before a
// helper (re)spawn. It must therefore return only the *listener* on the port.
// A client connected to the port — the user's browser pulling /stream.mjpeg
// from a previous helper — must never be listed: SIGKILLing the browser's
// network process aborts every in-flight fetch in the new preview tab, which
// is exactly the "Stream is not producing frames" failure.

const PORT = 3461;

function spawnNode(script: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.once("data", () => resolve(child));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`child exited early (${code})`)));
  });
}

let listener: ChildProcess;
let client: ChildProcess;

beforeAll(async () => {
  listener = await spawnNode(
    `const net = require("net");
     const srv = net.createServer((s) => s.pipe(s));
     srv.listen(${PORT}, "127.0.0.1", () => console.log("ready"));`,
  );
  client = await spawnNode(
    `const net = require("net");
     const s = net.connect(${PORT}, "127.0.0.1", () => console.log("connected"));
     s.on("error", () => {});
     setInterval(() => {}, 1000);`,
  );
});

afterAll(() => {
  client?.kill("SIGKILL");
  listener?.kill("SIGKILL");
});

describe("getPortHolders", () => {
  test("returns the listener pid", () => {
    expect(getPortHolders(PORT)).toContain(listener.pid!);
  });

  test("does not return pids of connected clients", () => {
    expect(getPortHolders(PORT)).not.toContain(client.pid!);
  });
});
