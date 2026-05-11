export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

export function parseSimctlList(stdout: string): SimDevice[] {
  try {
    const parsed = JSON.parse(stdout);
    const out: SimDevice[] = [];
    for (const [runtime, devs] of Object.entries<any[]>(parsed.devices ?? {})) {
      const runtimeName = runtime
        .replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "")
        .replace(/-/g, ".");
      for (const d of devs) {
        if (d.isAvailable) {
          out.push({ udid: d.udid, name: d.name, state: d.state, runtime: runtimeName });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function deviceKind(name: string): number {
  const n = name.toLowerCase();
  if (n.includes("iphone")) return 0;
  if (n.includes("ipad")) return 1;
  if (n.includes("watch")) return 2;
  if (n.includes("vision")) return 3;
  return 4;
}

export function runtimeOrder(runtime: string): number {
  const r = runtime.toLowerCase();
  if (r.startsWith("ios")) return 0;
  if (r.startsWith("ipados")) return 1;
  if (r.startsWith("watchos")) return 2;
  if (r.startsWith("visionos") || r.startsWith("xros")) return 3;
  return 4;
}
