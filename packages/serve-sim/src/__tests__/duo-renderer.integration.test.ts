import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { DuoRenderer } from "../duo-renderer";

const RENDERER_PATH = join(import.meta.dir, "../../dist/simduo/serve-sim-duo-render");

function duoModelPath(): string | null {
  try {
    const developer = process.env.DEVELOPER_DIR ?? execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" }).trim();
    return join(developer, "..", "SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources/V68.usdz");
  } catch {
    return null;
  }
}

const model = process.platform === "darwin" ? duoModelPath() : null;
// Needs a built renderer and an Xcode that ships the iPhone Duo model.
const shouldRun = existsSync(RENDERER_PATH) && model != null && existsSync(model);
// 1×1 baseline JPEG.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==", "base64");

describe.skipIf(!shouldRun)("Duo renderer (native)", () => {
  let renderer: DuoRenderer | undefined;

  afterEach(() => {
    renderer?.close();
    renderer = undefined;
  });

  // Regression: RealityKit asserts its shared engine is created on the main
  // queue. Loading the model first from the cooperative pool trapped (exit 133)
  // on macOS 26, so the 3D preview never produced a frame.
  test("loads the installed model and renders a frame", async () => {
    renderer = new DuoRenderer();
    const frame = await renderer.render(JPEG, "cover", 0, 0);
    expect(frame.jpeg.length).toBeGreaterThan(0);
    expect(frame.projection.width).toBe(1000);
    expect(frame.projection.height).toBe(900);
    expect(frame.projection.panel).toBe("cover");
    expect(frame.projection.pieces.length).toBeGreaterThan(0);
  }, 30_000);
});
