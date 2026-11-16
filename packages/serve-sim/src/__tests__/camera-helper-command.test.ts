import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { createServer, type Server, type Socket } from "net";
import { dirname } from "path";
import {
  cameraHelperBundlesFile,
  cameraHelperPidFile,
  cameraHelperSocketFile,
  readCameraStatus,
  readInjectedCameraBundles,
  sendCameraHelperCommand,
} from "../camera-helper";

// The host side of the camera helper's control socket (newline-delimited JSON)
// and its pid/bundles files: a helper that dies, hangs up, or answers garbage
// must reject the command instead of hanging the CLI, and a bundles file left
// by a previous helper must not be reported as injected.

const servers: Server[] = [];
const files: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const file of files.splice(0)) rmSync(file, { force: true });
});

/** A fresh device id with its helper state paths registered for cleanup. */
function device() {
  const udid = randomUUID().toUpperCase();
  const paths = [cameraHelperPidFile(udid), cameraHelperBundlesFile(udid), cameraHelperSocketFile(udid)];
  files.push(...paths);
  mkdirSync(dirname(paths[0]!), { recursive: true });
  return udid;
}

/** A fake helper listening on the device's socket; `onRequest` sees each request line. */
async function helper(udid: string, onRequest: (socket: Socket, line: string) => void): Promise<void> {
  const path = cameraHelperSocketFile(udid);
  try { unlinkSync(path); } catch {}
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) onRequest(socket, buffer.slice(0, newline));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

describe("camera helper command socket", () => {
  test("sends one JSON line and resolves with the first reply line", async () => {
    const udid = device();
    const requests: unknown[] = [];
    await helper(udid, (socket, line) => {
      requests.push(JSON.parse(line));
      socket.end('{"ok":true,"source":"file"}\n{"ignored":true}\n');
    });
    expect(await sendCameraHelperCommand(udid, { action: "swap", source: "file", arg: "/tmp/a b.png" })).toEqual({ ok: true, source: "file" });
    expect(requests).toEqual([{ action: "swap", source: "file", arg: "/tmp/a b.png" }]);
  });

  test("rejects without connecting when the helper socket is gone", async () => {
    await expect(sendCameraHelperCommand(device(), { action: "status" })).rejects.toThrow("camera helper socket not found");
  });

  test("a helper that hangs up without replying rejects with socket closed", async () => {
    const udid = device();
    await helper(udid, (socket) => socket.end());
    await expect(sendCameraHelperCommand(udid, { action: "status" })).rejects.toThrow("socket closed");
  });

  test("a reply that is not a JSON object is rejected", async () => {
    for (const reply of ["[1,2]", "null", "42", "not json"]) {
      const udid = device();
      await helper(udid, (socket) => socket.end(`${reply}\n`));
      const error = await sendCameraHelperCommand(udid, { action: "status" }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      if (reply !== "not json") expect((error as Error).message).toBe("invalid camera helper reply");
    }
  });

  test("a stale socket file with no listener rejects instead of hanging", async () => {
    const udid = device();
    writeFileSync(cameraHelperSocketFile(udid), "");
    await expect(sendCameraHelperCommand(udid, { action: "status" })).rejects.toThrow();
  });

  test("status reports a live helper whose socket errors, rather than throwing", async () => {
    const udid = device();
    await helper(udid, (socket) => socket.end());
    writeFileSync(cameraHelperPidFile(udid), String(process.pid));
    expect(await readCameraStatus(udid)).toEqual({
      udid, alive: true, helperPid: process.pid, bundleIds: [], error: "socket closed",
    });
  });
});

describe("injected camera bundles", () => {
  test("bundles recorded by a previous helper pid are not reported", () => {
    const udid = device();
    writeFileSync(cameraHelperPidFile(udid), String(process.pid));
    writeFileSync(cameraHelperBundlesFile(udid), JSON.stringify({ helperPid: process.pid + 1, bundleIds: ["com.example.app"] }));
    expect(readInjectedCameraBundles(udid)).toEqual([]);
    writeFileSync(cameraHelperBundlesFile(udid), JSON.stringify({ helperPid: process.pid, bundleIds: ["com.example.app"] }));
    expect(readInjectedCameraBundles(udid)).toEqual(["com.example.app"]);
  });

  test("missing pid file or malformed bundles file yields no bundles", () => {
    const udid = device();
    writeFileSync(cameraHelperBundlesFile(udid), JSON.stringify({ helperPid: process.pid, bundleIds: ["com.example.app"] }));
    expect(readInjectedCameraBundles(udid)).toEqual([]); // no pid file: no live helper
    writeFileSync(cameraHelperPidFile(udid), String(process.pid));
    for (const contents of ["{", "[]", '{"helperPid":"1","bundleIds":[]}', `{"helperPid":${process.pid},"bundleIds":"com.example.app"}`]) {
      writeFileSync(cameraHelperBundlesFile(udid), contents);
      expect(readInjectedCameraBundles(udid)).toEqual([]);
    }
  });
});
