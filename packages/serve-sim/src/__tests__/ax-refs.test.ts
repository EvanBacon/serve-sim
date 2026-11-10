import { describe, expect, test } from "bun:test";
import type { AxElement, AxSnapshot } from "../ax-shared";
import {
  agentSnapshot,
  assignRefs,
  diffSnapshots,
  identityKeys,
  isInterestingElement,
  isVisibleFrame,
  normalizeRef,
  resolveRef,
} from "../ax-refs";

const SCREEN = { width: 402, height: 874 };

function el(overrides: Partial<AxElement> = {}): AxElement {
  const path = overrides.path ?? "0.0";
  return {
    id: overrides.id ?? path,
    path,
    label: "",
    value: "",
    role: "button",
    type: "Button",
    enabled: true,
    frame: { x: 20, y: 100, width: 100, height: 44 },
    ...overrides,
  };
}

function snap(elements: AxElement[], screen = SCREEN): AxSnapshot {
  return { screen, elements, errors: [] };
}

describe("isVisibleFrame", () => {
  test("requires a non-zero size that intersects the screen", () => {
    expect(isVisibleFrame({ x: 0, y: 0, width: 10, height: 10 }, SCREEN)).toBe(true);
    expect(isVisibleFrame({ x: 10, y: 10, width: 0, height: 10 }, SCREEN)).toBe(false);
    expect(isVisibleFrame({ x: 10, y: 10, width: 10, height: 0 }, SCREEN)).toBe(false);
    expect(isVisibleFrame({ x: 0, y: 900, width: 100, height: 44 }, SCREEN)).toBe(false);
    expect(isVisibleFrame({ x: 0, y: -44, width: 100, height: 44 }, SCREEN)).toBe(false);
    expect(isVisibleFrame({ x: 500, y: 10, width: 100, height: 44 }, SCREEN)).toBe(false);
    // Partially onscreen counts as visible.
    expect(isVisibleFrame({ x: 0, y: 850, width: 100, height: 44 }, SCREEN)).toBe(true);
  });
});

describe("isInterestingElement", () => {
  test("keeps labelled, valued, identified, or interactive elements", () => {
    expect(isInterestingElement(el({ type: "Group", role: "", label: "Title" }))).toBe(true);
    expect(isInterestingElement(el({ type: "Group", role: "", value: "42" }))).toBe(true);
    expect(isInterestingElement(el({ type: "Group", role: "", id: "hero", path: "0.3" }))).toBe(true);
    expect(isInterestingElement(el({ type: "Button", label: "" }))).toBe(true);
    expect(isInterestingElement(el({ type: "TextField", role: "text field" }))).toBe(true);
  });

  test("drops unlabelled containers and zero-size elements", () => {
    expect(isInterestingElement(el({ type: "Group", role: "" }))).toBe(false);
    expect(isInterestingElement(el({ label: "Hidden", frame: { x: 0, y: 0, width: 0, height: 0 } }))).toBe(false);
  });
});

describe("identityKeys", () => {
  test("prefers AXUniqueId, then type + label (with an occurrence index), then path", () => {
    const keys = identityKeys([
      el({ id: "login", path: "0.0", label: "Log in" }),
      el({ path: "0.1", label: "Row", type: "Cell" }),
      el({ path: "0.2", label: "Row", type: "Cell" }),
      el({ path: "0.3", type: "Button" }),
    ]);
    expect(keys).toEqual(["id:login", "Cell|Row", "Cell|Row#2", "Button@0.3"]);
  });

  test("label-based keys survive sibling insertion (path changes)", () => {
    const before = identityKeys([el({ path: "0.0", label: "General", type: "Cell" })]);
    const after = identityKeys([
      el({ path: "0.0", label: "Banner", type: "StaticText" }),
      el({ path: "0.1", label: "General", type: "Cell" }),
    ]);
    expect(after[1]).toBe(before[0]!);
  });
});

describe("assignRefs + agentSnapshot", () => {
  const screen = snap([
    el({ path: "0.0", label: "Settings", type: "Heading", role: "heading", frame: { x: 16, y: 60, width: 200, height: 40.4 } }),
    el({ path: "0.1", label: "General", type: "Cell", role: "cell", frame: { x: 0, y: 300, width: 402, height: 52 } }),
    el({ path: "0.2", type: "Group", role: "" }), // uninteresting
    el({ path: "0.3", label: "Privacy", type: "Cell", role: "cell", value: "On", enabled: false, frame: { x: 0, y: 1200, width: 402, height: 52 } }),
  ]);

  test("assigns @e1..@eN in tree order to visible interesting elements", () => {
    const state = assignRefs(null, screen);
    const out = agentSnapshot(state);
    expect(out.screen).toEqual(SCREEN);
    expect(out.nodes.map((n) => n.ref)).toEqual(["@e1", "@e2"]);
    expect(out.nodes[0]).toEqual({
      ref: "@e1",
      role: "heading",
      type: "Heading",
      label: "Settings",
      frame: { x: 16, y: 60, w: 200, h: 40 },
      center: { x: 116, y: 80 },
    });
    // Empty value and enabled:true are omitted.
    expect("value" in out.nodes[1]!).toBe(false);
    expect("enabled" in out.nodes[1]!).toBe(false);
  });

  test("--all includes offscreen elements, marking them and reporting enabled:false and value", () => {
    const out = agentSnapshot(assignRefs(null, screen, { all: true }), { all: true });
    expect(out.nodes.map((n) => n.label)).toEqual(["Settings", "General", "Privacy"]);
    expect(out.nodes[2]).toMatchObject({ ref: "@e3", value: "On", enabled: false, offscreen: true });
  });

  test("identical screens produce identical refs", () => {
    const a = agentSnapshot(assignRefs(null, screen));
    const b = agentSnapshot(assignRefs(null, structuredClone(screen)));
    expect(b).toEqual(a);
  });

  test("elements that persist keep their ref; new elements get fresh, never-reused refs", () => {
    const first = assignRefs(null, screen);
    const next = assignRefs(first, snap([
      el({ path: "0.0", label: "New", type: "Button" }),
      el({ path: "0.1", label: "General", type: "Cell", role: "cell", frame: { x: 0, y: 300, width: 402, height: 52 } }),
    ]));
    const nodes = agentSnapshot(next).nodes;
    expect(nodes.find((n) => n.label === "General")?.ref).toBe("@e2");
    expect(nodes.find((n) => n.label === "New")?.ref).toBe("@e3");
    // @e1 (Settings) vanished; its ref is not reused.
    expect(resolveRef(next, "@e1")).toMatchObject({ ok: false, code: "stale_ref" });
  });

  test("a vanished element that returns gets a new ref (old one stays stale)", () => {
    const first = assignRefs(null, screen);
    const gone = assignRefs(first, snap([el({ path: "0.0", label: "Other" })]));
    const back = assignRefs(gone, screen);
    const general = agentSnapshot(back).nodes.find((n) => n.label === "General");
    expect(general?.ref).not.toBe("@e2");
  });

  test("ref bookkeeping is bounded by the current tree", () => {
    let state = assignRefs(null, screen);
    for (let i = 0; i < 50; i++) {
      state = assignRefs(state, snap([el({ path: "0.0", label: `Screen ${i}` })]));
    }
    expect(state.entries.size).toBe(1);
    expect(state.retired.length).toBeLessThanOrEqual(256);
  });
});

describe("normalizeRef / resolveRef", () => {
  test("accepts @e2, e2 and rejects junk", () => {
    expect(normalizeRef("@e2")).toBe("@e2");
    expect(normalizeRef("e2")).toBe("@e2");
    expect(normalizeRef(" @E12 ")).toBe("@e12");
    expect(normalizeRef("@x2")).toBeNull();
    expect(normalizeRef("@e")).toBeNull();
    expect(normalizeRef("@e0")).toBeNull();
  });

  test("resolves known refs to their entry", () => {
    const state = assignRefs(null, snap([el({ label: "OK" })]));
    const hit = resolveRef(state, "@e1");
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.entry.node.label).toBe("OK");
  });

  test("fails loudly with distinct codes for no snapshot, malformed, never-issued, and stale refs", () => {
    expect(resolveRef(null, "@e1")).toMatchObject({ ok: false, code: "no_snapshot" });
    const state = assignRefs(null, snap([el({ label: "OK" })]));
    expect(resolveRef(state, "nope")).toMatchObject({ ok: false, code: "invalid_ref" });
    const unknown = resolveRef(state, "@e99");
    expect(unknown).toMatchObject({ ok: false, code: "unknown_ref" });
    if (!unknown.ok) expect(unknown.message).toContain("serve-sim ax --refs");
    const later = assignRefs(state, snap([el({ label: "Other" })]));
    const stale = resolveRef(later, "@e1");
    expect(stale).toMatchObject({ ok: false, code: "stale_ref" });
    if (!stale.ok) {
      expect(stale.message).toContain("stale");
      expect(stale.message).toContain("OK");
    }
  });
});

describe("diffSnapshots", () => {
  test("reports added, removed and changed elements by identity", () => {
    const before = assignRefs(null, snap([
      el({ path: "0.0", label: "Settings", type: "Heading" }),
      el({ id: "wifi", path: "0.1", label: "Wi-Fi", value: "Off", type: "Cell" }),
      el({ path: "0.2", label: "General", type: "Cell" }),
    ]));
    const after = assignRefs(before, snap([
      el({ path: "0.0", label: "Settings", type: "Heading" }),
      el({ id: "wifi", path: "0.1", label: "Wi-Fi", value: "On", type: "Cell", enabled: false }),
      el({ path: "0.2", label: "About", type: "Cell" }),
    ]));
    const diff = diffSnapshots(before, after);
    expect(diff.added).toEqual([
      expect.objectContaining({ ref: "@e4", label: "About" }),
    ]);
    expect(diff.removed).toEqual([{ ref: "@e3", role: "button", label: "General" }]);
    expect(diff.changed).toEqual([
      { ref: "@e2", label: "Wi-Fi", fields: { value: ["Off", "On"], enabled: [true, false] } },
    ]);
  });

  test("frame moves are reported in rounded device points; sub-point jitter is ignored", () => {
    const before = assignRefs(null, snap([el({ label: "A", frame: { x: 0, y: 100, width: 50, height: 50 } })]));
    const jitter = assignRefs(before, snap([el({ label: "A", frame: { x: 0.2, y: 100.3, width: 50, height: 50 } })]));
    expect(diffSnapshots(before, jitter).changed).toEqual([]);
    const moved = assignRefs(jitter, snap([el({ label: "A", frame: { x: 0, y: 200, width: 50, height: 50 } })]));
    expect(diffSnapshots(jitter, moved).changed).toEqual([
      { ref: "@e1", label: "A", fields: { frame: [{ x: 0, y: 100, w: 50, h: 50 }, { x: 0, y: 200, w: 50, h: 50 }] } },
    ]);
  });

  test("elements scrolling off/on screen show up as removed/added by default", () => {
    const before = assignRefs(null, snap([
      el({ path: "0.0", label: "Top", frame: { x: 0, y: 10, width: 50, height: 50 } }),
      el({ path: "0.1", label: "Below", frame: { x: 0, y: 1000, width: 50, height: 50 } }),
    ]));
    const after = assignRefs(before, snap([
      el({ path: "0.0", label: "Top", frame: { x: 0, y: -500, width: 50, height: 50 } }),
      el({ path: "0.1", label: "Below", frame: { x: 0, y: 400, width: 50, height: 50 } }),
    ]));
    const diff = diffSnapshots(before, after);
    expect(diff.added.map((n) => n.label)).toEqual(["Below"]);
    expect(diff.removed.map((n) => n.label)).toEqual(["Top"]);
  });

  test("an unchanged screen yields an empty diff and a null 'before' diffs everything as added", () => {
    const state = assignRefs(null, snap([el({ label: "A" })]));
    expect(diffSnapshots(state, assignRefs(state, snap([el({ label: "A" })])))).toEqual({ added: [], removed: [], changed: [] });
    expect(diffSnapshots(null, state).added.map((n) => n.ref)).toEqual(["@e1"]);
  });
});
