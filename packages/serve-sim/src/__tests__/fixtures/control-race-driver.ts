// Drives dispatchViaControl under node with a synchronous stall injected
// right after a chosen client frame, to pin down what happens when the
// accept timer and the daemon's reply race.
import { dispatchViaControl } from "../../control-client";

const opts = JSON.parse(process.env.RACE_OPTS!) as {
  binFile: string;
  mainFile: string;
  argv: string[];
  stallAfter: string;
  stallMs: number;
  acceptTimeoutMs: number;
};

const result = await dispatchViaControl(opts.argv, {
  binFile: opts.binFile,
  mainFile: opts.mainFile,
  execPath: process.execPath,
  execArgv: [],
  env: process.env,
  cwd: () => process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  acceptTimeoutMs: opts.acceptTimeoutMs,
  afterWrite: (t) => {
    if (t !== opts.stallAfter) return;
    const end = Date.now() + opts.stallMs;
    while (Date.now() < end) {}
  },
});
process.stderr.write(`RESULT ${JSON.stringify(result)}\n`);
