// Run with Bun against the local server: bun .agents/skills/serve-sim-duo-verification/scripts/verify-duo-rotation.ts <udid> [port]
// Safari must be foreground; its cover UI supports portrait and both landscapes.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../../packages/serve-sim/package.json", import.meta.url));
const WebSocket = require("ws");
import { parseIntegratedScreenOrientations } from "../../../../packages/serve-sim/src/duo-state";

const [udid, port = "3200"] = process.argv.slice(2);
if (!udid) throw new Error("Pass the booted Duo UDID");
const base = `http://localhost:${port}/helper/${udid}`;
const ws = new WebSocket(`ws://localhost:${port}/helper/${udid}/ws`);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (tag: number, body: object) => ws.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(body))]));
await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
const original = await (await fetch(`${base}/config`)).json();
try {
  for (const hinge of [0, 130, 180]) {
    send(0x0e, { hinge });
    await pause(1800);
    const uiOrientations = new Set<string>();
    for (const [orientation, physical] of [
      ["landscape_right", "landscapeLeft"], ["portrait_upside_down", "portraitUpsideDown"],
      ["landscape_left", "landscapeRight"], ["portrait", "portrait"],
    ]) {
      send(0x07, { orientation });
      await pause(1200);
      const actual = execFileSync("xcrun", ["devicectl", "device", "orientation", "get", "--device", udid], { encoding: "utf8" });
      assert.match(actual, new RegExp(`Current Device Orientation: ${physical}\\s*$`));
      let config = await (await fetch(`${base}/config`)).json();
      assert.equal(config.duoViewOrientation, orientation);
      const panels = parseIntegratedScreenOrientations(execFileSync("xcrun", ["simctl", "io", udid, "enumerate"], { encoding: "utf8" }));
      const expectedUI = panels[hinge === 0 ? "cover" : "inner"];
      // Guest rotation and the shared orientation poll finish asynchronously.
      const deadline = Date.now() + 3000;
      while (config.orientation !== expectedUI && Date.now() < deadline) {
        await pause(100);
        config = await (await fetch(`${base}/config`)).json();
      }
      assert.equal(config.orientation, expectedUI, "Config must reflect guest UI readback");
      // The protocol uses screen/UI names; CoreDevice uses physical-device
      // names, whose landscape directions are opposite. Check the actual
      // relation to the model, not merely that all four orientations occur.
      const uprightInner: Record<string, string> = {
        portrait: "landscape_left", landscape_right: "portrait",
        portrait_upside_down: "landscape_right", landscape_left: "portrait_upside_down",
      };
      if (hinge !== 0 || orientation !== "portrait_upside_down") {
        assert.equal(config.orientation, hinge === 0 ? orientation : uprightInner[orientation!],
          "Guest UI must counter-rotate to stay upright on the model");
      }
      uiOrientations.add(config.orientation);
      console.log(`hinge ${hinge}: physical ${physical}, UI ${config.orientation}, view ${config.duoViewOrientation}`);
    }
    assert.equal(uiOrientations.size, hinge === 0 ? 3 : 4,
      `Safari should rotate its UI at hinge ${hinge} (the cover excludes upside-down portrait)`);
  }
} finally {
  send(0x0e, { hinge: original.hingeDegrees });
  send(0x07, { orientation: original.duoViewOrientation });
  await pause(500);
  ws.close();
}
