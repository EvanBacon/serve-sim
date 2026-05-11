import { describe, expect, test } from "bun:test";
import { groupTargetsByApp } from "../devtools-targets";

describe("groupTargetsByApp", () => {
  test("groups by bundleId and preserves first-seen order", () => {
    const groups = groupTargetsByApp([
      { id: "a", appName: "Safari", bundleId: "com.apple.mobilesafari" },
      { id: "b", appName: "MyApp", bundleId: "com.example.app" },
      { id: "c", appName: "Safari", bundleId: "com.apple.mobilesafari" },
    ]);

    expect(groups.map((g) => g.bundleId)).toEqual([
      "com.apple.mobilesafari",
      "com.example.app",
    ]);
    expect(groups[0]!.targets.map((t) => t.id)).toEqual(["a", "c"]);
    expect(groups[1]!.targets.map((t) => t.id)).toEqual(["b"]);
  });

  test("falls back to appName when bundleId is missing", () => {
    const groups = groupTargetsByApp([
      { id: "a", appName: "Safari" },
      { id: "b", appName: "Safari" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.appName).toBe("Safari");
    expect(groups[0]!.bundleId).toBeUndefined();
    expect(groups[0]!.targets.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("uses 'Unknown' when no identifying fields are present", () => {
    const groups = groupTargetsByApp([{ id: "a" }, { id: "b" }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.appName).toBe("Unknown");
  });

  test("treats matching bundleId with different appName as the same group", () => {
    const groups = groupTargetsByApp([
      { id: "a", appName: "MyApp", bundleId: "com.example.app" },
      { id: "b", appName: "MyApp Helper", bundleId: "com.example.app" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.targets).toHaveLength(2);
  });
});
