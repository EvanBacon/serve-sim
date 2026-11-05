// Built with `bun build --target=node` and run under Node by
// exec-ws-frame-limits.test.ts, so the control channel's frame limits are
// exercised against the real `ws` package — what the node-targeted
// `serve-sim` bin resolves at runtime. Under the Bun runtime, `import "ws"`
// is Bun's built-in shim instead.
//
// Usage: node harness.js <port> <execToken>. Prints one JSON line once
// listening, then runs until killed.

import { simMiddleware } from "../../middleware";
import { servePreview } from "../../runtime";

const port = Number(process.argv[2]);
const execToken = process.argv[3]!;
const middleware = simMiddleware({ basePath: "/", allowExec: true, execToken, device: "DEVICE-A" });
await servePreview({ port, middleware, host: "127.0.0.1" });
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, port }) + "\n");
