import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceHingeControls } from "../client/components/device-hinge-controls";
import { devicePosePresets } from "../device-pose";

// Regression guard: the Duo toolbar has exactly Closed · Book · Open. Extra
// hinge presets (tent, tabletop, …) must never leak into it again.

type RenderedButton = { label: string; pressed: string; icon: string };

function renderButtons(angle = 0): RenderedButton[] {
  const html = renderToStaticMarkup(
    <DeviceHingeControls angle={angle} onChange={() => {}} onPose={() => {}} />,
  );
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => ({
    label: /aria-label="([^"]*)"/.exec(attrs!)?.[1] ?? "",
    pressed: /aria-pressed="([^"]*)"/.exec(attrs!)?.[1] ?? "",
    // Only the glyph: the button body also holds a per-label tooltip.
    icon: /<svg[\s\S]*?<\/svg>/.exec(inner!)?.[0] ?? "",
  }));
}

function expectUnique(values: readonly unknown[]) {
  expect(new Set(values).size).toBe(values.length);
}

describe("Duo pose buttons", () => {
  test("defines exactly Closed, Book and Open", () => {
    const poses = devicePosePresets();
    expect(poses.map((pose) => pose.id)).toEqual(["closed", "book", "open"]);
    expect(poses.map((pose) => pose.label)).toEqual(["Closed", "Book", "Open"]);
    expect(poses.map((pose) => pose.hingeDegrees)).toEqual([0, 130, 180]);
    expect(poses.map((pose) => pose.coverActive)).toEqual([true, false, false]);
  });

  test("renders exactly three buttons", () => {
    const buttons = renderButtons();
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.label)).toEqual(["Closed pose", "Book pose", "Open pose"]);
  });

  test("has no duplicate labels, poses or icons", () => {
    const poses = devicePosePresets();
    expectUnique(poses.map((pose) => pose.id));
    expectUnique(poses.map((pose) => pose.label));
    expectUnique(poses.map((pose) => pose.hingeDegrees));
    const buttons = renderButtons();
    expectUnique(buttons.map((button) => button.label));
    expect(buttons.every((button) => button.icon.length > 0)).toBe(true);
    expectUnique(buttons.map((button) => button.icon));
  });

  test.each([
    [0, "Closed pose"],
    [130, "Book pose"],
    [180, "Open pose"],
  ])("highlights only the matching pose at %d°", (angle, label) => {
    const pressed = renderButtons(angle).filter((button) => button.pressed === "true");
    expect(pressed.map((button) => button.label)).toEqual([label]);
  });

  test("highlights nothing between poses", () => {
    expect(renderButtons(80).some((button) => button.pressed === "true")).toBe(false);
  });
});
