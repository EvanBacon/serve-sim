// Stand-in for dist/serve-sim-cli.js in control-process tests: built next to
// a real bin build, it reports what the process it ran in looked like.
import { appendFileSync } from "fs";
import { runCliMain } from "../../control-protocol";

// Simulates an install whose bundle can't load in a worker (only workers
// have an IPC channel), while direct runs still work.
if (process.env.FAKE_WORKER_LOAD_FAIL === "1" && process.send) throw new Error("cannot load ws");

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "--version") {
    console.log("fake 1.0.0");
    return;
  }
  if (command === "tap") {
    if (process.env.MARKER) appendFileSync(process.env.MARKER, `ran ${process.pid}\n`);
    console.log(
      JSON.stringify({
        argv: process.argv.slice(2),
        argv1: process.argv[1],
        cwd: process.cwd(),
        foo: process.env.FOO ?? null,
        role: process.env.SERVE_SIM_CONTROL_ROLE ?? null,
        stdoutIsTTY: process.stdout.isTTY === true,
        columns: process.stdout.columns ?? null,
        pid: process.pid,
        ppid: process.ppid,
      }),
    );
    process.stderr.write("to stderr\n");
    process.exitCode = Number(process.env.EXIT_CODE ?? 0);
    return;
  }
  if (command === "button") {
    console.log("exiting hard");
    process.exit(Number(rest[0] ?? 7));
  }
  if (command === "settle") {
    process.on("SIGINT", () => {
      console.log("got SIGINT");
      process.exit(130);
    });
    console.log("waiting");
    await new Promise((r) => setTimeout(r, 10_000));
    console.log("timed out");
    return;
  }
  if (command === "event-log") {
    // A big write followed by a hard exit must not lose output.
    process.stdout.write("x".repeat(Number(rest[0])));
    process.exit(0);
  }
  if (command === "gesture") {
    for (let i = 0; i < 40; i++) {
      process.stdout.write(`out${i}\n`);
      process.stderr.write(`err${i}\n`);
    }
    console.log(`ppid ${process.ppid}`);
    return;
  }
  if (command === "buffer") {
    console.log(
      JSON.stringify({
        pre: (globalThis as { __pre?: string }).__pre ?? null,
        execArgv: process.execArgv,
        nodeOptions: process.env.NODE_OPTIONS ?? null,
        ppid: process.ppid,
      }),
    );
    return;
  }
  if (command === "ax") {
    throw new Error("boom from ax");
  }
  console.log(`direct-only:${command ?? ""}`);
}

await runCliMain(main);
