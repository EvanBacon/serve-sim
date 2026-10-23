// `serve-sim hierarchy` — experimental companion to `--experimental-hierarchy-3d`.
import { findBootedDevice, resolveDevice } from "../device";
import { agentGet, isValidBundleId, launchWithAgent, pickAgent, readAgentRecords, waitForAgent } from "./agent";
import { normalizeAgentCapture } from "./model";

const USAGE = `Usage:
  serve-sim hierarchy <bundle-id> [-d udid]   Relaunch an app with the (experimental) view-hierarchy agent
  serve-sim hierarchy --dump [-d udid]        Print the injected foreground app's view tree as JSON

View it in 3D: serve-sim --experimental-hierarchy-3d, then open /hierarchy-3d.`;

export async function hierarchyCommand(args: string[]): Promise<void> {
  let device: string | undefined;
  let dump = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-d" || a === "--device") device = args[++i];
    else if (a === "--dump") dump = true;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return;
    } else positional.push(a);
  }
  const udid = device ? resolveDevice(device) : findBootedDevice();
  if (!udid) {
    console.error("No booted simulator. Boot one or pass -d <udid|name>.");
    process.exit(1);
  }

  if (dump) {
    const records = readAgentRecords(udid);
    const agent = pickAgent(records, null) ?? records[0];
    if (!agent) {
      console.error("No injected app found. Launch one with: serve-sim hierarchy <bundle-id>");
      process.exit(1);
    }
    const res = await agentGet(agent, "/hierarchy?snapshots=0");
    if (res.status !== 200) {
      console.error(`Agent answered ${res.status}`);
      process.exit(1);
    }
    const capture = normalizeAgentCapture(JSON.parse(res.body.toString("utf-8")), () => "");
    for (const w of capture.windows) stripSnapshotUrls(w);
    console.log(JSON.stringify(capture, null, 2));
    return;
  }

  const bundleId = positional[0];
  if (!bundleId || !isValidBundleId(bundleId)) {
    console.error(USAGE);
    process.exit(1);
  }
  const { pid, dylib } = await launchWithAgent(udid, bundleId);
  const agent = await waitForAgent(udid, pid);
  if (!agent) {
    console.error(`Launched ${bundleId} (pid ${pid ?? "?"}) but the hierarchy agent didn't register.`);
    process.exit(1);
  }
  console.log(`🧊 Hierarchy agent injected into ${bundleId} (pid ${agent.pid}) on ${udid}`);
  console.log(`   dylib: ${dylib}`);
}

function stripSnapshotUrls(node: { snapshot?: unknown; children: unknown[] }): void {
  delete node.snapshot;
  for (const c of node.children) stripSnapshotUrls(c as typeof node);
}
