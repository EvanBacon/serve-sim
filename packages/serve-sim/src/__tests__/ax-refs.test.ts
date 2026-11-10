import { describe, expect, test } from "bun:test";
import type { AxElement, AxSnapshot } from "../ax-shared";
import {
  agentSnapshot,
  assignRefs,
  diffSnapshots,
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

/** Labels of the elements that get a ref (with `all`, so visibility doesn't filter). */
function refLabels(elements: AxElement[]): string[] {
  return agentSnapshot(assignRefs(null, snap(elements), { all: true }), { all: true }).nodes.map((n) => n.label ?? `<${n.type}>`);
}

describe("interesting elements", () => {
  test("keeps labelled, valued, identified, or interactive elements", () => {
    expect(refLabels([
      el({ path: "0.0", type: "Group", role: "", label: "Title" }),
      el({ path: "0.1", type: "Group", role: "", value: "42" }),
      el({ path: "0.2", type: "Group", role: "", id: "hero" }),
      el({ path: "0.3", type: "Button" }),
      el({ path: "0.4", type: "TextField", role: "text field" }),
    ])).toEqual(["Title", "<Group>", "<Group>", "<Button>", "<TextField>"]);
  });

  test("drops unlabelled containers and zero-size elements", () => {
    expect(refLabels([
      el({ path: "0.0", type: "Group", role: "" }),
      el({ path: "0.1", label: "Hidden", frame: { x: 0, y: 0, width: 0, height: 0 } }),
    ])).toEqual([]);
  });

  test("reports AXUniqueId as id, never the path fallback", () => {
    const nodes = agentSnapshot(assignRefs(null, snap([el({ id: "login", path: "0.0", label: "Log in" }), el({ path: "0.1", label: "Other" })]))).nodes;
    expect(nodes[0]!.id).toBe("login");
    expect("id" in nodes[1]!).toBe(false);
  });
});

describe("identity keys (observed through ref carry-over)", () => {
  const refOf = (state: ReturnType<typeof assignRefs>, label: string) =>
    agentSnapshot(state, { all: true }).nodes.find((n) => n.label === label)?.ref;

  test("AXUniqueId wins: a relabelled element with the same id keeps its ref", () => {
    const before = assignRefs(null, snap([el({ id: "play", path: "0.0", label: "Play" })]));
    const after = assignRefs(before, snap([el({ id: "play", path: "0.5", label: "Pause" })]));
    expect(refOf(after, "Pause")).toBe("@e1");
    expect(diffSnapshots(before, after).changed).toEqual([{ ref: "@e1", label: "Pause", fields: { label: ["Play", "Pause"] } }]);
  });

  test("unique type + label keys survive sibling insertion and moves", () => {
    const before = assignRefs(null, snap([el({ path: "0.0", label: "General", type: "Cell" })]));
    const after = assignRefs(before, snap([
      el({ path: "0.0", label: "Banner", type: "StaticText" }),
      el({ path: "0.1", label: "General", type: "Cell" }),
    ]));
    expect(refOf(after, "General")).toBe("@e1");
  });

  test("duplicate labels are told apart by occurrence order", () => {
    const rows = (y: number) => snap([
      el({ path: "0.0", label: "Row", type: "Cell", value: "a", frame: { x: 0, y, width: 100, height: 40 } }),
      el({ path: "0.1", label: "Row", type: "Cell", value: "b", frame: { x: 0, y: y + 50, width: 100, height: 40 } }),
    ]);
    const before = assignRefs(null, rows(100));
    const after = assignRefs(before, rows(100));
    expect(agentSnapshot(after).nodes.map((n) => `${n.ref}=${n.value}`)).toEqual(["@e1=a", "@e2=b"]);
  });

  test("unlabelled elements keep their ref only while their frame matches", () => {
    const before = assignRefs(null, snap([el({ path: "0.3", type: "Button" })]));
    expect(agentSnapshot(assignRefs(before, snap([el({ path: "0.3", type: "Button" })]))).nodes[0]!.ref).toBe("@e1");
    // Same frame under a shifted path (a sibling of another type was inserted): same button.
    expect(agentSnapshot(assignRefs(before, snap([el({ path: "0.4", type: "Button" })]))).nodes[0]!.ref).toBe("@e1");
    // Same path, different place: not provably the same button.
    const moved = assignRefs(before, snap([el({ path: "0.3", type: "Button", frame: { x: 20, y: 400, width: 100, height: 44 } })]));
    expect(agentSnapshot(moved).nodes[0]!.ref).toBe("@e2");
    expect(resolveRef(moved, "@e1")).toMatchObject({ ok: false, code: "stale_ref" });
  });

  const row = (path: string, value: string, y: number) =>
    el({ path, label: "Row", type: "Cell", value, frame: { x: 0, y, width: 100, height: 40 } });
  const button = (path: string, y: number) => el({ path, type: "Button", frame: { x: 20, y, width: 44, height: 44 } });

  test("first duplicate removed: the survivor keeps its own ref and the removed ref goes stale", () => {
    const before = assignRefs(null, snap([row("0.0", "a", 100), row("0.1", "b", 150)]));
    expect(agentSnapshot(before).nodes.map((n) => `${n.ref}=${n.value}`)).toEqual(["@e1=a", "@e2=b"]);
    const after = assignRefs(before, snap([row("0.0", "b", 150)]));
    expect(agentSnapshot(after).nodes.map((n) => `${n.ref}=${n.value}`)).toEqual(["@e2=b"]);
    expect(resolveRef(after, "@e1")).toMatchObject({ ok: false, code: "stale_ref" });
    expect(diffSnapshots(before, after)).toEqual({ added: [], removed: [{ ref: "@e1", role: "button", label: "Row" }], changed: [] });
  });

  test("first duplicate removed and the survivor reflows into its slot: no ref is re-pointed", () => {
    const before = assignRefs(null, snap([row("0.0", "a", 100), row("0.1", "b", 150)]));
    const after = assignRefs(before, snap([row("0.0", "b", 100)]));
    expect(agentSnapshot(after).nodes.map((n) => `${n.ref}=${n.value}`)).toEqual(["@e3=b"]);
    expect(resolveRef(after, "@e1")).toMatchObject({ ok: false, code: "stale_ref" });
    expect(resolveRef(after, "@e2")).toMatchObject({ ok: false, code: "stale_ref" });
  });

  test("first of two indistinguishable duplicates removed: both refs retire", () => {
    const before = assignRefs(null, snap([row("0.0", "", 100), row("0.1", "", 150)]));
    const after = assignRefs(before, snap([row("0.0", "", 150)]));
    expect(agentSnapshot(after).nodes.map((n) => n.ref)).toEqual(["@e3"]);
    expect(resolveRef(after, "@e2")).toMatchObject({ ok: false, code: "stale_ref" });
  });

  test("duplicates swapped in place (same count, values moved): refs retire instead of following the slot", () => {
    const before = assignRefs(null, snap([row("0.0", "a", 100), row("0.1", "b", 150)]));
    const after = assignRefs(before, snap([row("0.0", "b", 100), row("0.1", "a", 150)]));
    expect(agentSnapshot(after).nodes.map((n) => n.ref)).toEqual(["@e3", "@e4"]);
  });

  test("sibling inserted before an unlabelled button: the old ref is retired, never moved to the newcomer", () => {
    const before = assignRefs(null, snap([button("0.0", 100)]));
    // The newcomer takes the old slot (and path); the original shifts down.
    const after = assignRefs(before, snap([button("0.0", 100), button("0.1", 150)]));
    expect(agentSnapshot(after).nodes.map((n) => n.ref)).toEqual(["@e2", "@e3"]);
    expect(resolveRef(after, "@e1")).toMatchObject({ ok: false, code: "stale_ref" });
  });

  test("sibling of another type inserted before an unlabelled button: the button keeps its ref", () => {
    const title = el({ path: "0.9", type: "Heading", label: "Title", frame: { x: 0, y: 40, width: 200, height: 30 } });
    const before = assignRefs(null, snap([button("0.0", 200), title]));
    const after = assignRefs(before, snap([el({ path: "0.0", type: "StaticText", label: "Hint", frame: { x: 0, y: 100, width: 100, height: 20 } }), button("0.1", 200), title]));
    expect(agentSnapshot(after).nodes.map((n) => `${n.ref}=${n.label ?? n.type}`)).toEqual(["@e3=Hint", "@e1=Button", "@e2=Title"]);
  });

  test("an inserted label is not proof for an unlabelled element when nothing labelled survived around it", () => {
    const before = assignRefs(null, snap([button("0.0", 200)]));
    const after = assignRefs(before, snap([el({ path: "0.0", type: "StaticText", label: "Hint", frame: { x: 0, y: 100, width: 100, height: 20 } }), button("0.1", 200)]));
    expect(resolveRef(after, "@e1")).toMatchObject({ ok: false, code: "stale_ref" });
  });

  test("duplicates that all moved by one offset with nothing to measure the scroll by: refs retire", () => {
    // A uniform shift alone can't tell a scroll of the same rows from reused
    // cells now showing other rows, so it is not proof of identity.
    const rows = (y: number) => snap([
      el({ path: "0.0", label: "Row", type: "Cell", value: "a", frame: { x: 0, y, width: 100, height: 40 } }),
      el({ path: "0.1", label: "Row", type: "Cell", value: "b", frame: { x: 0, y: y + 50, width: 100, height: 40 } }),
    ]);
    const before = assignRefs(null, rows(300));
    expect(agentSnapshot(assignRefs(before, rows(120))).nodes.map((n) => `${n.ref}=${n.value}`)).toEqual(["@e3=a", "@e4=b"]);
  });

  test("a value change keeps the ref (values are not part of the key)", () => {
    const before = assignRefs(null, snap([el({ label: "Name", type: "TextField", value: "" })]));
    const after = assignRefs(before, snap([el({ label: "Name", type: "TextField", value: "Evan" })]));
    expect(diffSnapshots(before, after).changed).toEqual([{ ref: "@e1", label: "Name", fields: { value: ["", "Evan"] } }]);
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
    const general = el({ path: "0.2", label: "General", type: "Cell", role: "cell", frame: { x: 0, y: 300, width: 402, height: 52 } });
    const privacy = el({ path: "0.3", label: "Privacy", type: "Cell", role: "cell", value: "On", enabled: false, frame: { x: 0, y: 1200, width: 402, height: 52 } });
    const next = assignRefs(first, snap([
      screen.elements[0]!,
      el({ path: "0.1", label: "New", type: "Button" }),
      general,
      privacy,
    ]));
    const nodes = agentSnapshot(next).nodes;
    expect(nodes.find((n) => n.label === "General")?.ref).toBe("@e2");
    expect(nodes.find((n) => n.label === "New")?.ref).toBe("@e3");
    // General vanishes; Settings keeps its ref and @e2 is never reused.
    const last = assignRefs(next, snap([screen.elements[0]!, el({ path: "0.1", label: "New", type: "Button" }), privacy]));
    expect(agentSnapshot(last).nodes.find((n) => n.label === "Settings")?.ref).toBe("@e1");
    expect(resolveRef(last, "@e2")).toMatchObject({ ok: false, code: "stale_ref" });
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
    const at = (y: number) => ({ frame: { x: 0, y, width: 402, height: 44 } });
    const before = assignRefs(null, snap([
      el({ path: "0.0", label: "Settings", type: "Heading", ...at(50) }),
      el({ id: "wifi", path: "0.1", label: "Wi-Fi", value: "Off", type: "Cell", ...at(100) }),
      el({ path: "0.2", label: "General", type: "Cell", ...at(144) }),
      el({ path: "0.3", label: "Bluetooth", type: "Cell", ...at(188) }),
    ]));
    // "General" removed and "About" added elsewhere (not swapped in place,
    // which would retire every ref, see the in-place swap tests).
    const after = assignRefs(before, snap([
      el({ path: "0.0", label: "Settings", type: "Heading", ...at(50) }),
      el({ id: "wifi", path: "0.1", label: "Wi-Fi", value: "On", type: "Cell", enabled: false, ...at(100) }),
      el({ path: "0.2", label: "Bluetooth", type: "Cell", ...at(188) }),
      el({ path: "0.3", label: "About", type: "Cell", ...at(400) }),
    ]));
    const diff = diffSnapshots(before, after);
    expect(diff.added).toEqual([
      expect.objectContaining({ ref: "@e5", label: "About" }),
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

describe("ref identity is judged against the whole previous tree", () => {
  const item = (path: string, y: number, value = "") =>
    el({ path, label: "Item", type: "Cell", value, frame: { x: 0, y, width: 402, height: 44 } });

  test("deleting a visible row with an offscreen duplicate never hands its ref to the duplicate", () => {
    // A is visible (@e1); B shares its label but is offscreen, so it has no ref.
    const before = assignRefs(null, snap([item("0.0", 100), item("0.1", 2000)]));
    expect(agentSnapshot(before).nodes.map((n) => n.ref)).toEqual(["@e1"]);
    // A is deleted and B reflows into its slot.
    const after = assignRefs(before, snap([item("0.0", 100)]));
    expect(agentSnapshot(after).nodes.map((n) => n.ref)).toEqual(["@e2"]);
    expect(resolveRef(after, "@e1")).toMatchObject({ ok: false, code: "stale_ref" });
  });

  test("the value fallback also counts offscreen duplicates", () => {
    const before = assignRefs(null, snap([item("0.0", 100, "a"), item("0.1", 2000, "a"), item("0.2", 2044, "b")]));
    expect(agentSnapshot(before).nodes.map((n) => `${n.ref}=${n.value}`)).toEqual(["@e1=a"]);
    const after = assignRefs(before, snap([item("0.0", 100, "a"), item("0.1", 144, "b")]));
    expect(agentSnapshot(after).nodes.map((n) => n.ref)).not.toContain("@e1");
    expect(resolveRef(after, "@e1")).toMatchObject({ ok: false, code: "stale_ref" });
  });

  test("a group that really had one member keeps the ref wherever it moves", () => {
    const before = assignRefs(null, snap([item("0.0", 100), el({ path: "0.1", label: "Other", type: "Cell", frame: { x: 0, y: 2000, width: 402, height: 44 } })]));
    const after = assignRefs(before, snap([item("0.0", 300), el({ path: "0.1", label: "Other", type: "Cell", frame: { x: 0, y: 2000, width: 402, height: 44 } })]));
    expect(agentSnapshot(after).nodes.map((n) => n.ref)).toEqual(["@e1"]);
  });
});

describe("scrolled lists of duplicates", () => {
  const NAMES = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank", "Grace"];
  const ROW = 44;
  /** A reused-cell table at path 0.1: only `rows` are exposed, row i of the window at top + i*ROW. */
  const table = (rows: number[], top: number, opts: { labelledCells?: boolean } = {}) =>
    snap([
      el({ path: "0.0", label: "Contacts", type: "Heading", role: "heading", frame: { x: 0, y: 40, width: 402, height: 40 } }),
      ...rows.flatMap((row, slot) => {
        const y = top + row * ROW;
        const name = NAMES[row]!;
        return [
          el({ path: `0.1.${slot}`, type: "Cell", role: "cell", label: opts.labelledCells ? name : "", frame: { x: 0, y, width: 402, height: ROW } }),
          el({ path: `0.1.${slot}.0`, type: "StaticText", role: "text", label: opts.labelledCells ? "" : name, frame: { x: 16, y: y + 12, width: 200, height: 20 } }),
          el({ path: `0.1.${slot}.1`, label: "Delete", frame: { x: 320, y: y + 4, width: 70, height: 36 } }),
        ];
      }),
    ]);
  /** Which named row each Delete ref sits in. */
  const deleteRows = (state: ReturnType<typeof assignRefs>) => {
    const nodes = agentSnapshot(state, { all: true }).nodes;
    const out = new Map<string, string>();
    for (const node of nodes) {
      if (node.label !== "Delete") continue;
      const row = nodes.find((n) => n.type !== "Button" && n.label && n.frame.y <= node.center.y && node.center.y < n.frame.y + n.frame.h && n.frame.x < node.frame.x);
      out.set(node.ref, row?.label ?? "?");
    }
    return out;
  };
  /** Every ref present on both sides names a Delete button in the same row. */
  const expectNoRepointing = (before: ReturnType<typeof assignRefs>, after: ReturnType<typeof assignRefs>) => {
    const a = deleteRows(before);
    for (const [ref, row] of deleteRows(after)) {
      if (a.has(ref)) expect(`${ref} in ${row}`).toBe(`${ref} in ${a.get(ref)}`);
    }
  };

  test("a scrolled window of same-label cells does not carry refs to other rows", () => {
    const before = assignRefs(null, table([0, 1, 2, 3, 4], 100));
    const after = assignRefs(before, table([2, 3, 4, 5, 6], 0));
    expectNoRepointing(before, after);
    const deleteRefs = [...deleteRows(after).keys()];
    for (const ref of deleteRows(before).keys()) expect(deleteRefs).not.toContain(ref);
  });

  test("a scroll by exactly one row height retires the duplicate refs", () => {
    const before = assignRefs(null, table([0, 1, 2, 3, 4], 100));
    // Every Delete button lands exactly where the previous row's was.
    const after = assignRefs(before, table([1, 2, 3, 4, 5], 100 - ROW));
    expectNoRepointing(before, after);
    const deleteRefs = [...deleteRows(after).keys()];
    for (const ref of deleteRows(before).keys()) expect(deleteRefs).not.toContain(ref);
  });

  test("duplicates inside labelled rows are grouped per row and follow their row", () => {
    const before = assignRefs(null, table([0, 1, 2, 3, 4], 100, { labelledCells: true }));
    const after = assignRefs(before, table([1, 2, 3, 4, 5], 100 - ROW, { labelledCells: true }));
    expectNoRepointing(before, after);
    // Bob's Delete keeps its ref after the scroll.
    const bob = [...deleteRows(before)].find(([, row]) => row === "Bob")![0];
    expect(deleteRows(after).get(bob)).toBe("Bob");
  });

  test("duplicates scrolled together with a unique anchor in their container keep their refs", () => {
    // The rows and the section header that scrolls with them share a container.
    const rows = (y: number) => snap([
      el({ path: "0.0.0", label: "Fruits", type: "StaticText", role: "text", frame: { x: 0, y: y - 30, width: 100, height: 20 } }),
      el({ path: "0.0.1", label: "Row", type: "Cell", value: "a", frame: { x: 0, y, width: 100, height: 40 } }),
      el({ path: "0.0.2", label: "Row", type: "Cell", value: "b", frame: { x: 0, y: y + 50, width: 100, height: 40 } }),
    ]);
    const before = assignRefs(null, rows(300));
    expect(agentSnapshot(assignRefs(before, rows(120))).nodes.map((n) => `${n.ref}=${n.label}${n.value ?? ""}`))
      .toEqual(["@e1=Fruits", "@e2=Rowa", "@e3=Rowb"]);
  });
  /** Refs of every node of `type` (all of them, offscreen included). */
  const refsOf = (state: ReturnType<typeof assignRefs>, type: string) =>
    agentSnapshot(state, { all: true }).nodes.filter((n) => n.type === type).map((n) => n.ref);
  const expectNoCarry = (before: ReturnType<typeof assignRefs>, after: ReturnType<typeof assignRefs>, type: string) => {
    const old = new Set(refsOf(before, type));
    expect(refsOf(after, type).filter((ref) => old.has(ref))).toEqual([]);
  };

  test("re-snapshotting an unchanged list keeps every ref", () => {
    const before = assignRefs(null, table([0, 1, 2], 100));
    const after = assignRefs(before, table([0, 1, 2], 100));
    expect(agentSnapshot(after, { all: true })).toEqual(agentSnapshot(before, { all: true }));
  });

  test("a list wholly replaced at the same frames retires the duplicate buttons' refs", () => {
    // Alice/Bob/Carol -> Dave/Erin/Frank in the same cells, nothing left to measure a scroll by.
    const before = assignRefs(null, table([0, 1, 2], 100));
    const after = assignRefs(before, table([3, 4, 5], 100 - 3 * ROW));
    expectNoRepointing(before, after);
    expectNoCarry(before, after, "Button");
  });

  test("unlabelled cells named by a child label: an entirely new list at the same frames retires the cell refs", () => {
    const before = assignRefs(null, table([0, 1, 2], 100));
    const after = assignRefs(before, table([3, 4, 5], 100 - 3 * ROW));
    expectNoCarry(before, after, "Cell");
  });

  test("a sticky header inside the list is not enough to keep refs across a full-page scroll", () => {
    const header = el({ path: "0.1.9", type: "StaticText", label: "Friends", frame: { x: 0, y: 90, width: 402, height: 10 } });
    const withHeader = (state: AxSnapshot) => snap([...state.elements, header]);
    const before = assignRefs(null, withHeader(table([0, 1, 2], 100)));
    // The header stays put (offset 0) while every row underneath changed.
    const after = assignRefs(before, withHeader(table([3, 4, 5], 100 - 3 * ROW)));
    expectNoRepointing(before, after);
    expectNoCarry(before, after, "Button");
    expectNoCarry(before, after, "Cell");
  });

  test("duplicate accessibilityIdentifiers are told apart by their row and follow it", () => {
    const rows = (names: string[], top: number) => snap(names.flatMap((name, slot) => {
      const y = top + slot * ROW;
      return [
        el({ path: `0.1.${slot}`, type: "Cell", role: "cell", label: name, frame: { x: 0, y, width: 402, height: ROW } }),
        el({ path: `0.1.${slot}.0`, id: "delete", label: "Delete", frame: { x: 320, y: y + 4, width: 70, height: 36 } }),
      ];
    }));
    const before = assignRefs(null, rows(["Alice", "Bob", "Carol"], 100));
    const after = assignRefs(before, rows(["Bob", "Carol", "Dave"], 100));
    const deleteIn = (state: ReturnType<typeof assignRefs>, name: string) => {
      const nodes = agentSnapshot(state).nodes;
      const cell = nodes.find((n) => n.label === name)!;
      return nodes.find((n) => n.id === "delete" && n.frame.y === cell.frame.y + 4)!.ref;
    };
    expect(deleteIn(after, "Bob")).toBe(deleteIn(before, "Bob"));
    expect(resolveRef(after, deleteIn(before, "Alice"))).toMatchObject({ ok: false, code: "stale_ref" });
  });

  test("look-alike rows with nothing at all to tell them apart retire instead of keeping refs", () => {
    // A scroll by exactly one row looks identical to no change, so neither keeps refs.
    const grid = () => snap([
      el({ path: "0.0", type: "Heading", label: "Photos", frame: { x: 0, y: 40, width: 402, height: 40 } }),
      ...[0, 1, 2].map((i) => el({ path: `0.1.${i}`, type: "Button", frame: { x: 0, y: 100 + i * 100, width: 100, height: 100 } })),
    ]);
    const before = assignRefs(null, grid());
    const after = assignRefs(before, grid());
    expectNoCarry(before, after, "Button");
    expect(refsOf(after, "Heading")).toEqual(refsOf(before, "Heading"));
  });
});

describe("lone matches need their context to survive", () => {
  const detail = (name: string, opts: { deleteId?: string } = {}) => snap([
    el({ path: "0.0", label: "Back", frame: { x: 0, y: 50, width: 60, height: 44 } }),
    el({ path: "0.1.0", type: "Heading", role: "heading", label: name, frame: { x: 16, y: 100, width: 300, height: 40 } }),
    el({ path: "0.1.1", label: "Delete", ...(opts.deleteId ? { id: opts.deleteId } : {}), frame: { x: 16, y: 600, width: 370, height: 44 } }),
  ]);
  const refOf = (state: ReturnType<typeof assignRefs>, label: string) =>
    agentSnapshot(state).nodes.find((n) => n.label === label)?.ref;

  test("a lone 'Delete' next to Alice is not the 'Delete' next to Bob after a push", () => {
    const before = assignRefs(null, detail("Alice"));
    const after = assignRefs(before, detail("Bob"));
    expect(refOf(after, "Delete")).not.toBe(refOf(before, "Delete"));
    expect(resolveRef(after, refOf(before, "Delete")!)).toMatchObject({ ok: false, code: "stale_ref" });
    // The screen's title changed, so even chrome around it retires: Bob's
    // "Back" is not provably Alice's.
    expect(resolveRef(after, refOf(before, "Back")!)).toMatchObject({ ok: false, code: "stale_ref" });
  });

  test("the same lone 'Delete' keeps its ref while its context stays", () => {
    const before = assignRefs(null, detail("Alice"));
    expect(refOf(assignRefs(before, detail("Alice")), "Delete")).toBe(refOf(before, "Delete"));
  });

  test("a unique AXUniqueId reused on another record's screen retires (RN testID on every detail screen)", () => {
    const before = assignRefs(null, detail("Alice", { deleteId: "delete-contact" }));
    const after = assignRefs(before, detail("Bob", { deleteId: "delete-contact" }));
    expect(resolveRef(after, refOf(before, "Delete")!)).toMatchObject({ ok: false, code: "stale_ref" });
  });

  test("a unique AXUniqueId keeps its ref on the same screen, even relabelled", () => {
    const before = assignRefs(null, detail("Alice", { deleteId: "delete-contact" }));
    const ref = refOf(before, "Delete")!;
    const relabelled = detail("Alice", { deleteId: "delete-contact" });
    relabelled.elements[2] = { ...relabelled.elements[2]!, label: "Remove" };
    expect(refOf(assignRefs(before, relabelled), "Remove")).toBe(ref);
  });

  const toolbarScreen = (title: string) => snap([
    el({ path: "0.0", type: "Heading", role: "heading", label: title, frame: { x: 16, y: 50, width: 300, height: 40 } }),
    el({ path: "0.1.0", type: "Button", frame: { x: 350, y: 800, width: 44, height: 44 } }),
  ]);

  test("an icon-only toolbar button replaced by another screen's in the same spot retires its ref", () => {
    const before = assignRefs(null, toolbarScreen("Inbox"));
    const button = agentSnapshot(before).nodes.find((n) => n.type === "Button")!.ref;
    const after = assignRefs(before, toolbarScreen("Settings"));
    expect(resolveRef(after, button)).toMatchObject({ ok: false, code: "stale_ref" });
  });

  test("the icon-only toolbar button keeps its ref on the same screen", () => {
    const before = assignRefs(null, toolbarScreen("Inbox"));
    const button = agentSnapshot(before).nodes.find((n) => n.type === "Button")!.ref;
    expect(resolveRef(assignRefs(before, toolbarScreen("Inbox")), button)).toMatchObject({ ok: true });
  });
});

describe("shared chrome and field headers never carry a ref to another record", () => {
  const text = (label: string) => ({ type: "StaticText", role: "text", label });
  const refWhere = (state: ReturnType<typeof assignRefs>, pred: (n: ReturnType<typeof agentSnapshot>["nodes"][number]) => boolean) =>
    agentSnapshot(state, { all: true }).nodes.find(pred)?.ref;
  const expectStale = (state: ReturnType<typeof assignRefs>, ref: string | undefined) => {
    expect(ref).toBeDefined();
    expect(resolveRef(state, ref!)).toMatchObject({ ok: false, code: "stale_ref" });
  };

  // A: the record shows only in plain labels; "phone"/"email" headers are shared.
  const contact = (name: string, phone: string, email: string) => snap([
    el({ path: "0.0", label: "Contacts", frame: { x: 0, y: 50, width: 90, height: 44 } }),
    el({ path: "0.1.0", ...text(name), frame: { x: 16, y: 100, width: 300, height: 40 } }),
    el({ path: "0.1.1", ...text("phone"), frame: { x: 16, y: 160, width: 100, height: 20 } }),
    el({ path: "0.1.2", ...text(phone), frame: { x: 16, y: 180, width: 200, height: 20 } }),
    el({ path: "0.1.3", ...text("email"), frame: { x: 16, y: 220, width: 100, height: 20 } }),
    el({ path: "0.1.4", ...text(email), frame: { x: 16, y: 240, width: 200, height: 20 } }),
    el({ path: "0.1.5", label: "Delete Contact", frame: { x: 16, y: 600, width: 370, height: 44 } }),
  ]);

  test("A: 'Delete Contact' on Alice's card is not Bob's, though the field headers survive", () => {
    const before = assignRefs(null, contact("Alice", "555-0001", "a@x.com"));
    const after = assignRefs(before, contact("Bob", "555-0002", "b@x.com"));
    expectStale(after, refWhere(before, (n) => n.label === "Delete Contact"));
  });

  test("A: re-reading Alice's card keeps every ref", () => {
    const before = assignRefs(null, contact("Alice", "555-0001", "a@x.com"));
    const after = assignRefs(before, contact("Alice", "555-0001", "a@x.com"));
    expect(agentSnapshot(after, { all: true })).toEqual(agentSnapshot(before, { all: true }));
  });

  // B: the record shows only in the heading and in the cells' values.
  const settingsDetail = (name: string, title: "Heading" | "NavigationBar" = "Heading") => snap([
    title === "Heading"
      ? el({ path: "0.0", type: "Heading", role: "heading", label: name, frame: { x: 16, y: 50, width: 300, height: 40 } })
      : el({ path: "0.0", type: "NavigationBar", role: "nav bar", id: name, frame: { x: 0, y: 50, width: 402, height: 44 } }),
    el({ path: "0.1", type: "Cell", label: "Phone", value: `${name}-phone`, frame: { x: 0, y: 100, width: 402, height: 44 } }),
    el({ path: "0.2", type: "Cell", label: "Email", value: `${name}-mail`, frame: { x: 0, y: 144, width: 402, height: 44 } }),
    el({ path: "0.3", type: "Cell", label: "Address", value: `${name}-addr`, frame: { x: 0, y: 188, width: 402, height: 44 } }),
    el({ path: "0.4", type: "Button", frame: { x: 350, y: 50, width: 44, height: 44 } }), // icon-only favourite
    el({ path: "0.5", label: "Delete", frame: { x: 16, y: 600, width: 370, height: 44 } }),
  ]);
  const favourite = (n: { type: string; label?: string }) => n.type === "Button" && !n.label;

  test("B: only the title and the field values change: the icon-only favourite retires", () => {
    const before = assignRefs(null, settingsDetail("Alice"));
    const after = assignRefs(before, settingsDetail("Bob"));
    expectStale(after, refWhere(before, favourite));
  });

  test("B: only the title and the field values change: 'Delete' retires", () => {
    const before = assignRefs(null, settingsDetail("Alice"));
    const after = assignRefs(before, settingsDetail("Bob"));
    expectStale(after, refWhere(before, (n) => n.label === "Delete"));
  });

  test("B: a navigation-bar title change retires refs the same way", () => {
    const before = assignRefs(null, settingsDetail("Alice", "NavigationBar"));
    const after = assignRefs(before, settingsDetail("Bob", "NavigationBar"));
    expectStale(after, refWhere(before, (n) => n.label === "Delete"));
    expectStale(after, refWhere(before, favourite));
  });

  test("B: a replaced title alone (identical field values) retires the screen's refs", () => {
    const sameFields = (name: string) => {
      const screen = settingsDetail("Alice");
      screen.elements[0] = { ...screen.elements[0]!, label: name };
      return screen;
    };
    const before = assignRefs(null, sameFields("Alice"));
    const after = assignRefs(before, sameFields("Bob"));
    expectStale(after, refWhere(before, (n) => n.label === "Delete"));
    expectStale(after, refWhere(before, favourite));
  });

  test("B: values alone tell records apart when there is no title", () => {
    const untitled = (name: string) => snap(settingsDetail(name).elements.slice(1));
    const before = assignRefs(null, untitled("Alice"));
    const after = assignRefs(before, untitled("Bob"));
    expectStale(after, refWhere(before, (n) => n.label === "Delete"));
  });

  test("B: re-reading Alice's detail screen keeps every ref, icon-only button included", () => {
    const before = assignRefs(null, settingsDetail("Alice"));
    const after = assignRefs(before, settingsDetail("Alice"));
    expect(agentSnapshot(after, { all: true })).toEqual(agentSnapshot(before, { all: true }));
    expect(refWhere(after, favourite)).toBe(refWhere(before, favourite));
  });

  test("an on/off cell value flipping is state, not another record: neighbours keep their refs", () => {
    const screen = (wifi: string) => snap([
      el({ path: "0.0", type: "Heading", role: "heading", label: "Settings", frame: { x: 16, y: 50, width: 300, height: 40 } }),
      el({ path: "0.1", type: "Cell", label: "Wi-Fi", value: wifi, frame: { x: 0, y: 100, width: 402, height: 44 } }),
      el({ path: "0.2", type: "Cell", label: "Bluetooth", frame: { x: 0, y: 144, width: 402, height: 44 } }),
    ]);
    const before = assignRefs(null, screen("Off"));
    const after = assignRefs(before, screen("On"));
    expect(agentSnapshot(after).nodes.map((n) => n.ref)).toEqual(agentSnapshot(before).nodes.map((n) => n.ref));
  });

  // C: a flat container (SwiftUI ScrollView/VStack) of tab buttons, a heading and rows.
  const ROW = 60;
  const inbox = (names: string[]) => snap([
    ...["Home", "Search", "Profile", "Settings"].map((t, i) =>
      el({ path: `0.${i}`, type: "Button", label: t, frame: { x: i * 100, y: 820, width: 100, height: 50 } })),
    el({ path: "0.4", type: "Heading", role: "heading", label: "Inbox", frame: { x: 16, y: 50, width: 300, height: 40 } }),
    ...names.flatMap((name, i) => [
      el({ path: `0.${5 + 2 * i}`, ...text(name), frame: { x: 16, y: 100 + i * ROW, width: 200, height: 20 } }),
      el({ path: `0.${6 + 2 * i}`, label: "Reply", frame: { x: 320, y: 100 + i * ROW, width: 70, height: 36 } }),
    ]),
  ]);
  const replies = (state: ReturnType<typeof assignRefs>) =>
    agentSnapshot(state, { all: true }).nodes.filter((n) => n.label === "Reply").map((n) => n.ref);

  test("C: sticky chrome can't outvote replaced rows: a full-page scroll retires the Reply refs", () => {
    const before = assignRefs(null, inbox(["Alice", "Bob"]));
    const after = assignRefs(before, inbox(["Carol", "Dave"]));
    const old = new Set(replies(before));
    expect(replies(after).filter((ref) => old.has(ref))).toEqual([]);
    // Other rows now sit where Alice's and Bob's were: an in-place swap, so
    // even the unchanged tab bar retires (churn, but nothing retargets).
    expectStale(after, refWhere(before, (n) => n.label === "Home"));
  });

  test("C: re-reading the unchanged inbox keeps the Reply refs", () => {
    const before = assignRefs(null, inbox(["Alice", "Bob"]));
    expect(replies(assignRefs(before, inbox(["Alice", "Bob"])))).toEqual(replies(before));
  });

  // D: heading + a shared section title + a lone labelled "Delete".
  const notes = (name: string, section: "StaticText" | "Heading") => snap([
    el({ path: "0.0", type: "Heading", role: "heading", label: name, frame: { x: 16, y: 50, width: 300, height: 40 } }),
    el({ path: "0.1", type: section, role: section === "Heading" ? "heading" : "text", label: "Notes", frame: { x: 16, y: 100, width: 100, height: 20 } }),
    el({ path: "0.2", label: "Delete", frame: { x: 16, y: 600, width: 370, height: 44 } }),
  ]);

  for (const section of ["StaticText", "Heading"] as const) {
    test(`D: one shared section title (${section}) doesn't carry 'Delete' from Alice to Bob`, () => {
      const before = assignRefs(null, notes("Alice", section));
      const after = assignRefs(before, notes("Bob", section));
      expectStale(after, refWhere(before, (n) => n.label === "Delete"));
    });
  }

  test("D: the same record re-read keeps 'Delete'", () => {
    const before = assignRefs(null, notes("Alice", "StaticText"));
    const after = assignRefs(before, notes("Alice", "StaticText"));
    expect(refWhere(after, (n) => n.label === "Delete")).toBe(refWhere(before, (n) => n.label === "Delete"));
  });
});

describe("other content in the same place retires every ref (review 203e)", () => {
  type State = ReturnType<typeof assignRefs>;
  const text = (label: string) => ({ type: "StaticText", role: "text", label });
  const heading = (label: string) => ({ type: "Heading", role: "heading", label });
  const refWhere = (state: State, pred: (n: ReturnType<typeof agentSnapshot>["nodes"][number]) => boolean) =>
    agentSnapshot(state, { all: true }).nodes.find(pred)?.ref;
  const expectStale = (state: State, ref: string | undefined) => {
    expect(ref).toBeDefined();
    expect(resolveRef(state, ref!)).toMatchObject({ ok: false, code: "stale_ref" });
  };
  const carried = (before: State, after: State) =>
    agentSnapshot(before, { all: true }).nodes.filter((n) => resolveRef(after, n.ref).ok).map((n) => n.label ?? n.type);
  const unchanged = (screen: () => AxSnapshot) => {
    const before = assignRefs(null, screen());
    expect(agentSnapshot(assignRefs(before, screen()), { all: true })).toEqual(agentSnapshot(before, { all: true }));
  };

  // E1: an iOS-Contacts-style card. The name is plain text, the nav bar has
  // no title, and the shared action buttons outnumber the record's labels.
  const card = (name: string, phone: string) => snap([
    el({ path: "0.0", label: "Contacts", frame: { x: 0, y: 50, width: 90, height: 44 } }),
    el({ path: "0.1", label: "Edit", frame: { x: 330, y: 50, width: 60, height: 44 } }),
    el({ path: "0.2.0", ...text(name), frame: { x: 16, y: 200, width: 370, height: 40 } }),
    el({ path: "0.2.1", label: "message", frame: { x: 16, y: 250, width: 80, height: 60 } }),
    el({ path: "0.2.2", label: "call", frame: { x: 106, y: 250, width: 80, height: 60 } }),
    el({ path: "0.2.3", label: "video", frame: { x: 196, y: 250, width: 80, height: 60 } }),
    el({ path: "0.2.4", label: "mail", frame: { x: 286, y: 250, width: 80, height: 60 } }),
    el({ path: "0.2.5", type: "Cell", label: `mobile, ${phone}`, frame: { x: 0, y: 330, width: 402, height: 60 } }),
    el({ path: "0.2.6", label: "Send Message", frame: { x: 0, y: 420, width: 402, height: 44 } }),
    el({ path: "0.2.7", label: "Share Contact", frame: { x: 0, y: 464, width: 402, height: 44 } }),
    el({ path: "0.2.8", label: "Add to Favourites", frame: { x: 0, y: 508, width: 402, height: 44 } }),
    el({ path: "0.2.9", label: "Block this Caller", frame: { x: 0, y: 600, width: 402, height: 44 } }),
  ]);

  test("E1: shared action buttons can't carry 'Block this Caller' from Alice's card to Bob's", () => {
    const before = assignRefs(null, card("Alice Smith", "555-0001"));
    const after = assignRefs(before, card("Bob Jones", "555-0002"));
    expect(carried(before, after)).toEqual([]);
    expectStale(after, refWhere(before, (n) => n.label === "Block this Caller"));
  });

  test("E1: re-reading Alice's card keeps every ref", () => unchanged(() => card("Alice Smith", "555-0001")));

  test("E1 minimal: one plain-text name outvoted by three action buttons", () => {
    const minimal = (name: string) => snap(card(name, "x").elements.filter((e) => ["0.2.0", "0.2.6", "0.2.7", "0.2.8", "0.2.9"].includes(e.path)));
    const before = assignRefs(null, minimal("Alice"));
    expect(before.entries.size).toBe(5);
    const after = assignRefs(before, minimal("Bob"));
    expectStale(after, refWhere(before, (n) => n.label === "Block this Caller"));
  });

  // E2: a generic nav title ("Contact") comes first; the record heading sits
  // in another group than the footer actions.
  const generic = (name: string) => snap([
    el({ path: "0.0", type: "Group", role: "Nav bar", id: "Contact", frame: { x: 0, y: 50, width: 402, height: 44 } }),
    el({ path: "0.0.0", label: "Back", frame: { x: 0, y: 50, width: 60, height: 44 } }),
    el({ path: "0.0.1", ...text("Contact"), frame: { x: 150, y: 50, width: 100, height: 44 } }),
    el({ path: "0.0.2", label: "Edit", frame: { x: 330, y: 50, width: 60, height: 44 } }),
    el({ path: "0.1.0", ...heading(name), frame: { x: 16, y: 110, width: 300, height: 40 } }),
    el({ path: "0.1.1", type: "Cell", label: "Phone", value: `${name}-p`, frame: { x: 0, y: 160, width: 402, height: 44 } }),
    el({ path: "0.2.0", label: "Share Contact", frame: { x: 0, y: 500, width: 402, height: 44 } }),
    el({ path: "0.2.1", label: "Add to Favourites", frame: { x: 0, y: 544, width: 402, height: 44 } }),
    el({ path: "0.2.2", label: "Delete Contact", frame: { x: 0, y: 600, width: 402, height: 44 } }),
  ]);

  test("E2: a generic nav title before the record heading doesn't hide the replaced heading", () => {
    const before = assignRefs(null, generic("Alice"));
    const after = assignRefs(before, generic("Bob"));
    expect(carried(before, after)).toEqual([]);
    expectStale(after, refWhere(before, (n) => n.label === "Delete Contact"));
  });

  test("E2: re-reading the same contact keeps every ref", () => unchanged(() => generic("Alice")));

  // E3: the record shows only in button values.
  const buttonValues = (name: string) => snap([
    el({ path: "0.0", ...heading("Details"), frame: { x: 16, y: 50, width: 300, height: 40 } }),
    el({ path: "0.1", label: "Phone", value: `${name}-p`, frame: { x: 0, y: 100, width: 402, height: 44 } }),
    el({ path: "0.2", label: "Email", value: `${name}-e`, frame: { x: 0, y: 144, width: 402, height: 44 } }),
    el({ path: "0.3", label: "Delete", frame: { x: 0, y: 600, width: 402, height: 44 } }),
  ]);

  test("E3: button values are content: 'Delete' doesn't carry from Alice to Bob", () => {
    const before = assignRefs(null, buttonValues("Alice"));
    const after = assignRefs(before, buttonValues("Bob"));
    expectStale(after, refWhere(before, (n) => n.label === "Delete"));
  });

  test("E3: re-reading the same record keeps every ref", () => unchanged(() => buttonValues("Alice")));

  test("an AXUniqueId-keyed name relabelled in place is another record", () => {
    const named = (name: string) => snap([
      el({ path: "0.0", ...text(name), id: "contact-name", frame: { x: 16, y: 100, width: 300, height: 40 } }),
      el({ path: "0.1", label: "Share", frame: { x: 0, y: 500, width: 402, height: 44 } }),
      el({ path: "0.2", label: "Delete", frame: { x: 0, y: 600, width: 402, height: 44 } }),
    ]);
    const before = assignRefs(null, named("Alice"));
    const after = assignRefs(before, named("Bob"));
    expectStale(after, refWhere(before, (n) => n.label === "Delete"));
  });

  // E4: documented gap. Typed text is not content (no focus in the AX tree
  // to tell typing from another record's form), so two forms that differ
  // only in a text field's value carry refs. See the README.
  test("E4 (documented gap): forms differing only in a text field's value keep refs", () => {
    const form = (name: string) => snap([
      el({ path: "0.0", ...heading("Edit Contact"), frame: { x: 16, y: 50, width: 300, height: 40 } }),
      el({ path: "0.1", type: "TextField", role: "text field", label: "First name", value: name, frame: { x: 0, y: 100, width: 402, height: 44 } }),
      el({ path: "0.2", label: "Delete Contact", frame: { x: 0, y: 600, width: 402, height: 44 } }),
    ]);
    const before = assignRefs(null, form("Alice"));
    const after = assignRefs(before, form("Bob"));
    expect(resolveRef(after, refWhere(before, (n) => n.label === "Delete Contact")!).ok).toBe(true);
  });

  // E6: Bob's screen still loading: Alice's heading is gone and nothing replaced it yet.
  const loading = (name: string | null) => snap([
    ...(name ? [el({ path: "0.0", ...heading(name), frame: { x: 16, y: 50, width: 300, height: 40 } })] : []),
    el({ path: "0.1", label: "Contacts", frame: { x: 0, y: 0, width: 90, height: 44 } }),
    el({ path: "0.2", label: "Edit", frame: { x: 330, y: 0, width: 60, height: 44 } }),
    el({ path: "0.3", label: "Share", frame: { x: 0, y: 500, width: 402, height: 44 } }),
    el({ path: "0.4", type: "Cell", label: "Phone", value: "—", frame: { x: 0, y: 100, width: 402, height: 44 } }),
    el({ path: "0.5", label: "Delete", frame: { x: 0, y: 600, width: 402, height: 44 } }),
  ]);

  test("E6: a visible heading that vanished without scrolling away retires every ref", () => {
    const before = assignRefs(null, loading("Alice"));
    const after = assignRefs(before, loading(null));
    expect(carried(before, after)).toEqual([]);
  });

  test("a section header scrolled offscreen with its content is not a vanished title", () => {
    const sections = (dy: number, withA: boolean) => snap([
      el({ path: "0.0", label: "Edit", frame: { x: 330, y: 50, width: 60, height: 44 } }),
      ...(withA ? [el({ path: "0.1.0", ...heading("Section A"), frame: { x: 16, y: 100 + dy, width: 300, height: 40 } })] : []),
      ...[0, 1, 2, 3, 4].map((i) => el({ path: `0.1.${i + 1}`, type: "Cell", label: `Row ${i}`, frame: { x: 0, y: 150 + i * 60 + dy, width: 402, height: 60 } })),
      el({ path: "0.1.6", ...heading("Section B"), frame: { x: 16, y: 460 + dy, width: 300, height: 40 } }),
      el({ path: "0.1.7", label: "Delete", frame: { x: 0, y: 510 + dy, width: 402, height: 44 } }),
    ]);
    const before = assignRefs(null, sections(0, true));
    const after = assignRefs(before, sections(-150, false));
    for (const label of ["Edit", "Row 3", "Section B", "Delete"]) {
      expect(refWhere(after, (n) => n.label === label)).toBe(refWhere(before, (n) => n.label === label));
    }
  });

  test("E7: headings that swapped order (linked contacts) retire every ref", () => {
    const related = (name: string, other: string) => snap([
      el({ path: "0.0", ...heading(name), frame: { x: 16, y: 50, width: 300, height: 40 } }),
      el({ path: "0.1", ...text("phone"), frame: { x: 16, y: 100, width: 100, height: 20 } }),
      el({ path: "0.2", label: "Delete", frame: { x: 0, y: 600, width: 402, height: 44 } }),
      el({ path: "0.3", ...heading(other), frame: { x: 16, y: 700, width: 300, height: 40 } }),
    ]);
    const before = assignRefs(null, related("Alice", "Bob"));
    const after = assignRefs(before, related("Bob", "Alice"));
    expectStale(after, refWhere(before, (n) => n.label === "Delete"));
  });

  // F3: rows named only by a value-only StaticText (label "").
  const ROW = 60;
  const valueRows = (names: string[]) => snap([
    el({ path: "0.0", ...heading("Inbox"), frame: { x: 16, y: 50, width: 300, height: 40 } }),
    ...["Home", "Search", "Profile", "Settings"].map((t, i) => el({ path: `0.${i + 1}`, label: t, frame: { x: i * 100, y: 820, width: 100, height: 50 } })),
    ...names.flatMap((n, i) => [
      el({ path: `0.${5 + 2 * i}`, type: "StaticText", role: "text", value: n, frame: { x: 16, y: 100 + i * ROW, width: 200, height: 20 } }),
      el({ path: `0.${6 + 2 * i}`, label: "Reply", frame: { x: 320, y: 100 + i * ROW, width: 70, height: 36 } }),
    ]),
  ]);
  const replies = (state: State) => agentSnapshot(state, { all: true }).nodes.filter((n) => n.label === "Reply").map((n) => n.ref);

  test("F3: value-only row names are keyed: a full-page scroll retires the Reply refs", () => {
    const before = assignRefs(null, valueRows(["Alice", "Bob"]));
    const after = assignRefs(before, valueRows(["Carol", "Dave"]));
    const old = new Set(replies(before));
    expect(replies(after).filter((ref) => old.has(ref))).toEqual([]);
  });

  test("F3: re-reading the same rows keeps the Reply refs", () => {
    const before = assignRefs(null, valueRows(["Alice", "Bob"]));
    expect(replies(assignRefs(before, valueRows(["Alice", "Bob"])))).toEqual(replies(before));
  });

  test("a row deleted with the rest reflowing up is not a swap: the surviving rows keep their refs", () => {
    const rows = (names: string[]) => snap([
      el({ path: "0.0", ...heading("Inbox"), frame: { x: 16, y: 50, width: 300, height: 40 } }),
      ...names.map((n, i) => el({ path: `0.${i + 1}`, type: "Cell", label: n, frame: { x: 0, y: 100 + i * ROW, width: 402, height: ROW } })),
    ]);
    const before = assignRefs(null, rows(["Alice", "Bob", "Carol"]));
    const after = assignRefs(before, rows(["Alice", "Carol"]));
    expect(refWhere(after, (n) => n.label === "Carol")).toBe(refWhere(before, (n) => n.label === "Carol"));
    expect(refWhere(after, (n) => n.label === "Alice")).toBe(refWhere(before, (n) => n.label === "Alice"));
  });

  test("churn (documented): a status line changing in place retires every ref", () => {
    const status = (line: string) => snap([
      el({ path: "0.0", ...heading("Downloads"), frame: { x: 16, y: 50, width: 300, height: 40 } }),
      el({ path: "0.1", ...text(line), frame: { x: 16, y: 100, width: 300, height: 20 } }),
      el({ path: "0.2", label: "Cancel", frame: { x: 0, y: 600, width: 402, height: 44 } }),
    ]);
    const before = assignRefs(null, status("3 of 5"));
    const after = assignRefs(before, status("4 of 5"));
    expectStale(after, refWhere(before, (n) => n.label === "Cancel"));
  });
});
