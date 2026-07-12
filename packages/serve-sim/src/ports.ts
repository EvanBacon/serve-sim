/** TCP port ownership helpers for helper lifecycle management. */
import { execSync } from "child_process";
import { sleepSync } from "./runtime";

/**
 * Return PIDs currently *listening* on a TCP port (excluding ourselves).
 *
 * The LISTEN filter is load-bearing: a bare `lsof -ti tcp:<port>` also lists
 * processes holding *client* sockets to the port — most notably the user's
 * browser streaming MJPEG from a previous helper. Killing those SIGKILLs the
 * browser's network process, which aborts every in-flight fetch in the new
 * preview tab and surfaces as "Stream is not producing frames".
 */
export function getPortHolders(port: number): number[] {
  try {
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (!output) return [];
    const myPid = process.pid;
    return output
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((pid) => Number.isFinite(pid) && pid !== myPid);
  } catch {
    return [];
  }
}

/** Kill whatever process is listening on a given port. Logs the PIDs being killed. */
export function killPortHolder(port: number): void {
  const pids = getPortHolders(port);
  if (pids.length === 0) return;
  console.log(`\x1b[90mPort ${port} busy, killing listener pid(s): ${pids.join(", ")}\x1b[0m`);
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  sleepSync(100);
}
