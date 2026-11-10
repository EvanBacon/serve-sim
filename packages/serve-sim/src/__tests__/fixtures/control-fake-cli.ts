// Stand-in for dist/serve-sim-cli.js in control-process tests: built next to
// a real bin build, it reports what the process it ran in looked like.
import { runCliMain } from "../../control-protocol";

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "--version") {
    console.log("fake 1.0.0");
    return;
  }
  if (command === "tap") {
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
  if (command === "ax") {
    throw new Error("boom from ax");
  }
  console.log(`direct-only:${command ?? ""}`);
}

await runCliMain(main);
