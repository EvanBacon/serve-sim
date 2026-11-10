/**
 * Agent-grade view of an accessibility snapshot: short element refs (`@e1`),
 * compact nodes in device points, and a stable diff between two snapshots.
 *
 * Pure: takes the {@link AxSnapshot} the existing AX collection path produces
 * (`normalizeAxTree`) and never talks to the simulator. The server keeps one
 * {@link RefState} per device so `tap @e2` resolves against the last snapshot
 * the agent saw (see ax-agent.ts).
 *
 * Ref rules:
 * - The first snapshot numbers interesting, visible elements @e1..@eN in tree
 *   order (`all` includes offscreen ones).
 * - Later snapshots keep the ref of every element that is unambiguously the
 *   same one (a unique id or label, or for duplicates and unlabelled
 *   elements a matching frame), and give new elements the next unused
 *   number. A ref is never reused for a different element, so a stale ref
 *   fails instead of silently pointing at whatever now occupies its slot.
 */
import type { AxElement, AxRect, AxSnapshot } from "./ax-shared";

interface AgentFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface AgentNode {
  ref: string;
  role: string;
  type: string;
  label?: string;
  value?: string;
  /** AXUniqueId (accessibilityIdentifier), when the app set one. */
  id?: string;
  /** Present (false) only for disabled elements. */
  enabled?: false;
  /** Rounded device points. */
  frame: AgentFrame;
  center: { x: number; y: number };
  /** Present only in `all` snapshots, for elements outside the screen. */
  offscreen?: true;
}

export interface AgentSnapshot {
  screen: { width: number; height: number };
  nodes: AgentNode[];
}

export interface RefEntry {
  ref: string;
  /** Identity group (see identityGroup); a ref only carries over within one. */
  key: string;
  node: AgentNode;
  visible: boolean;
  /** Unrounded frame, for computing an exact tap point. */
  rect: AxRect;
}

export interface RefState {
  screen: { width: number; height: number };
  /** Ref'd elements present in the latest tree, in tree order. */
  entries: Map<string, RefEntry>;
  /** Refs of elements that vanished, newest last (bounded), for stale-ref messages. */
  retired: Array<{ ref: string; role: string; label: string }>;
  nextRef: number;
}

export interface AgentDiff {
  added: AgentNode[];
  removed: Array<{ ref: string; role: string; label: string }>;
  changed: Array<{ ref: string; label: string; fields: Record<string, [unknown, unknown]> }>;
}

export type RefLookup =
  | { ok: true; entry: RefEntry }
  | { ok: false; code: "no_snapshot" | "invalid_ref" | "unknown_ref" | "stale_ref"; message: string };

const MAX_RETIRED = 256;
export const RESNAPSHOT_HINT = "Run `serve-sim ax --refs` to take a fresh snapshot, then retry with a current ref.";

/** Roles worth a ref even without a label (macOS AX role names, `AX` prefix stripped). */
const INTERACTIVE_TYPES = new Set([
  "Button",
  "Cell",
  "CheckBox",
  "ComboBox",
  "DisclosureTriangle",
  "Incrementor",
  "Key",
  "Link",
  "MenuButton",
  "MenuItem",
  "PopUpButton",
  "RadioButton",
  "Row",
  "SearchField",
  "SecureTextField",
  "Slider",
  "Switch",
  "Tab",
  "TextArea",
  "TextField",
  "Toggle",
]);

export function isVisibleFrame(frame: AxRect, screen: { width: number; height: number }): boolean {
  if (!(frame.width > 0) || !(frame.height > 0)) return false;
  return frame.x < screen.width && frame.y < screen.height && frame.x + frame.width > 0 && frame.y + frame.height > 0;
}

function hasUniqueId(element: AxElement): boolean {
  // normalizeAxTree falls back to the tree path when AXUniqueId is null.
  return element.id !== "" && element.id !== element.path;
}

function isInterestingElement(element: AxElement): boolean {
  if (!(element.frame.width > 0) || !(element.frame.height > 0)) return false;
  return element.label !== "" || element.value !== "" || hasUniqueId(element) || INTERACTIVE_TYPES.has(element.type);
}

/**
 * Identity group per element: `id:<AXUniqueId>`, else `<type>|<label>`, else
 * `<type>@` (all unlabelled elements of a type). Values are deliberately
 * excluded so typing into a field reads as a change, not a replacement.
 * A group with one member on both sides is the same element; anything else
 * (duplicate labels, unlabelled elements) is matched by frame, see
 * {@link matchGroup}.
 */
function identityGroup(element: AxElement): { key: string; unique: boolean } {
  if (hasUniqueId(element)) return { key: `id:${element.id}`, unique: true };
  if (element.label !== "") return { key: `${element.type}|${element.label}`, unique: true };
  return { key: `${element.type}@`, unique: false };
}

/** Points each frame edge may drift and still name the same element. */
const FRAME_TOLERANCE = 8;

function framesClose(a: AxRect, b: AxRect): boolean {
  return Math.abs(a.x - b.x) <= FRAME_TOLERANCE
    && Math.abs(a.y - b.y) <= FRAME_TOLERANCE
    && Math.abs(a.width - b.width) <= FRAME_TOLERANCE
    && Math.abs(a.height - b.height) <= FRAME_TOLERANCE;
}

/** Every member moved by one shared offset, sizes within tolerance: a scrolled list. */
function uniformlyTranslated(prev: RefEntry[], current: AxElement[]): boolean {
  const dx = current[0]!.frame.x - prev[0]!.rect.x;
  const dy = current[0]!.frame.y - prev[0]!.rect.y;
  return prev.every((entry, i) => {
    const frame = current[i]!.frame;
    return Math.abs(frame.x - entry.rect.x - dx) <= 1
      && Math.abs(frame.y - entry.rect.y - dy) <= 1
      && Math.abs(frame.width - entry.rect.width) <= FRAME_TOLERANCE
      && Math.abs(frame.height - entry.rect.height) <= FRAME_TOLERANCE;
  });
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/**
 * Which previous entry (index into `prev`) each current member of one
 * identity group continues, or -1 for a new element. Only unambiguous
 * matches carry a ref:
 * - one labelled/identified member on both sides: the same element, wherever it is;
 * - one unlabelled member on both sides with a close frame;
 * - same count of duplicates, in order, with equal values and every frame
 *   close (or all shifted by one offset, i.e. scrolled);
 * - when the count changed: a member whose value is unique on both sides
 *   and whose frame is still close.
 * Anything else retires the old ref. Deleting a row makes its siblings
 * reflow into its slot, so position alone can't say which one survived;
 * a stale ref is better than a tap on the wrong element.
 */
function matchGroup(prev: RefEntry[], current: AxElement[], unique: boolean): number[] {
  const result = current.map(() => -1);
  if (prev.length === 0) return result;
  if (prev.length === 1 && current.length === 1) {
    return unique || framesClose(prev[0]!.rect, current[0]!.frame) ? [0] : result;
  }
  if (prev.length === current.length
    && prev.every((entry, i) => (entry.node.value ?? "") === current[i]!.value)
    && (prev.every((entry, i) => framesClose(entry.rect, current[i]!.frame)) || uniformlyTranslated(prev, current))) {
    return current.map((_, i) => i);
  }
  const prevValues = countValues(prev.map((entry) => entry.node.value ?? ""));
  const currentValues = countValues(current.map((element) => element.value));
  current.forEach((element, c) => {
    if (prevValues.get(element.value) !== 1 || currentValues.get(element.value) !== 1) return;
    const p = prev.findIndex((entry) => (entry.node.value ?? "") === element.value);
    if (framesClose(prev[p]!.rect, element.frame)) result[c] = p;
  });
  return result;
}

function roundFrame(frame: AxRect): AgentFrame {
  return { x: Math.round(frame.x), y: Math.round(frame.y), w: Math.round(frame.width), h: Math.round(frame.height) };
}

function compactNode(ref: string, element: AxElement, visible: boolean): AgentNode {
  return {
    ref,
    role: element.role || element.type,
    type: element.type,
    ...(element.label ? { label: element.label } : {}),
    ...(element.value ? { value: element.value } : {}),
    ...(hasUniqueId(element) ? { id: element.id } : {}),
    ...(element.enabled ? {} : { enabled: false as const }),
    frame: roundFrame(element.frame),
    center: {
      x: Math.round(element.frame.x + element.frame.width / 2),
      y: Math.round(element.frame.y + element.frame.height / 2),
    },
    ...(visible ? {} : { offscreen: true as const }),
  };
}

function summary(entry: RefEntry) {
  return { ref: entry.ref, role: entry.node.role, label: entry.node.label ?? "" };
}

/**
 * Build the next ref state from a fresh snapshot. Elements already ref'd in
 * `prev` keep their ref wherever they are; other interesting elements get a
 * new ref when visible (or always with `all`).
 */
export function assignRefs(prev: RefState | null, snapshot: AxSnapshot, opts: { all?: boolean } = {}): RefState {
  const screen = { width: snapshot.screen.width, height: snapshot.screen.height };
  const interesting = snapshot.elements.filter(isInterestingElement);
  const groups = interesting.map(identityGroup);

  const previousByGroup = new Map<string, RefEntry[]>();
  for (const entry of prev?.entries.values() ?? []) {
    const list = previousByGroup.get(entry.key);
    if (list) list.push(entry);
    else previousByGroup.set(entry.key, [entry]);
  }
  const currentByGroup = new Map<string, number[]>();
  groups.forEach((group, index) => {
    const list = currentByGroup.get(group.key);
    if (list) list.push(index);
    else currentByGroup.set(group.key, [index]);
  });
  const carried = new Map<number, RefEntry>();
  for (const [key, indexes] of currentByGroup) {
    const previous = previousByGroup.get(key) ?? [];
    const matches = matchGroup(previous, indexes.map((i) => interesting[i]!), groups[indexes[0]!]!.unique);
    matches.forEach((p, i) => {
      if (p >= 0) carried.set(indexes[i]!, previous[p]!);
    });
  }

  let nextRef = prev?.nextRef ?? 1;
  const entries = new Map<string, RefEntry>();
  interesting.forEach((element, index) => {
    const key = groups[index]!.key;
    const visible = isVisibleFrame(element.frame, screen);
    const existing = carried.get(index);
    if (!existing && !visible && !opts.all) return;
    const ref = existing?.ref ?? `@e${nextRef++}`;
    entries.set(ref, { ref, key, node: compactNode(ref, element, visible), visible, rect: element.frame });
  });

  const retired = [...(prev?.retired ?? [])];
  for (const entry of prev?.entries.values() ?? []) {
    if (!entries.has(entry.ref)) retired.push(summary(entry));
  }
  if (retired.length > MAX_RETIRED) retired.splice(0, retired.length - MAX_RETIRED);

  return { screen, entries, retired, nextRef };
}

/** The JSON an agent sees: visible nodes only unless `all`. */
export function agentSnapshot(state: RefState, opts: { all?: boolean } = {}): AgentSnapshot {
  const nodes: AgentNode[] = [];
  for (const entry of state.entries.values()) {
    if (entry.visible || opts.all) nodes.push(entry.node);
  }
  return { screen: state.screen, nodes };
}

/** `@e2`, `e2`, ` @E2 ` → `@e2`; anything else → null. */
export function normalizeRef(input: string): string | null {
  const match = /^@?e([1-9]\d*)$/i.exec(input.trim());
  return match ? `@e${match[1]}` : null;
}

/** "cell \"General\"", or "unlabelled element". */
export function describeElement(element: { role: string; label?: string }): string {
  return [element.role, element.label ? `"${element.label}"` : ""].filter(Boolean).join(" ") || "unlabelled element";
}

/** The one stale-ref message, whether the ref retired at snapshot time or right before a tap. */
export function staleRefMessage(ref: string, element: { role: string; label?: string }): string {
  return `${ref} is stale: the element it named (${describeElement(element)}) is no longer on screen. ${RESNAPSHOT_HINT}`;
}

export function resolveRef(state: RefState | null, input: string): RefLookup {
  const ref = normalizeRef(input);
  if (!ref) {
    return { ok: false, code: "invalid_ref", message: `"${input}" is not an element ref (expected e.g. @e2).` };
  }
  if (!state) {
    return { ok: false, code: "no_snapshot", message: `No snapshot has been taken on this device, so ${ref} is unknown. ${RESNAPSHOT_HINT}` };
  }
  const entry = state.entries.get(ref);
  if (entry) return { ok: true, entry };
  let retired: RefState["retired"][number] | undefined;
  for (let i = state.retired.length - 1; i >= 0 && !retired; i--) {
    if (state.retired[i]!.ref === ref) retired = state.retired[i];
  }
  if (retired) return { ok: false, code: "stale_ref", message: staleRefMessage(ref, retired) };
  return { ok: false, code: "unknown_ref", message: `${ref} is not in the latest snapshot. ${RESNAPSHOT_HINT}` };
}

function sameFrame(a: AgentFrame, b: AgentFrame) {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * What changed between two ref states, keyed by ref (which assignRefs only
 * carries forward for the same element). Compares
 * visible elements only unless `all`, so scrolling reads as removed/added.
 */
export function diffSnapshots(before: RefState | null, after: RefState, opts: { all?: boolean } = {}): AgentDiff {
  const include = (entry: RefEntry) => entry.visible || opts.all === true;
  const beforeByRef = new Map<string, RefEntry>();
  for (const entry of before?.entries.values() ?? []) if (include(entry)) beforeByRef.set(entry.ref, entry);

  const diff: AgentDiff = { added: [], removed: [], changed: [] };
  const matched = new Set<string>();
  for (const entry of after.entries.values()) {
    if (!include(entry)) continue;
    const old = beforeByRef.get(entry.ref);
    if (!old) {
      diff.added.push(entry.node);
      continue;
    }
    matched.add(entry.ref);
    const fields: Record<string, [unknown, unknown]> = {};
    const a = old.node;
    const b = entry.node;
    if ((a.label ?? "") !== (b.label ?? "")) fields.label = [a.label ?? "", b.label ?? ""];
    if ((a.value ?? "") !== (b.value ?? "")) fields.value = [a.value ?? "", b.value ?? ""];
    if ((a.enabled ?? true) !== (b.enabled ?? true)) fields.enabled = [a.enabled ?? true, b.enabled ?? true];
    if (!sameFrame(a.frame, b.frame)) fields.frame = [a.frame, b.frame];
    if (Object.keys(fields).length > 0) diff.changed.push({ ref: entry.ref, label: b.label ?? "", fields });
  }
  for (const [ref, entry] of beforeByRef) {
    if (!matched.has(ref)) diff.removed.push(summary(entry));
  }
  return diff;
}
