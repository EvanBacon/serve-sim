import { simEndpoint } from "./sim-endpoint";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function execOnHost(command: string): Promise<ExecResult> {
  const res = await fetch(simEndpoint("exec"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  return res.json();
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
