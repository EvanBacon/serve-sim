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
 *   number. When identity is in doubt the ref retires: a stale ref fails
 *   loudly, which beats a tap on whatever now occupies its slot.
 * - "Unique" is judged against the whole previous tree, offscreen elements
 *   included, not just the elements that got a ref.
 * - Nothing carries at all when the screen shows other content in the same
 *   place: a keyed text swapped for a new one in its frame, a keyed
 *   element's read-only value changed, a visible title gone without
 *   scrolling away, or titles reordered (see {@link screenReplaced}).
 * - Otherwise neither a unique id/label nor position is enough on its own:
 *   the uniquely labelled content around an element must have survived too
 *   (the first heading or navigation-bar title of each enclosing scope kept,
 *   most of its nearest context and of its own row's neighbours still
 *   there, read-only values included), see {@link contextSurvived}. That
 *   applies to AXUniqueIds too.
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

/** One interesting element of the latest tree, ref'd or not, as later matching needs it. */
interface GroupMember {
  /** Null for elements that never got a ref (offscreen without `all`). */
  ref: string | null;
  path: string;
  value: string;
  rect: AxRect;
}

/** An element whose labelled or identified key occurs once in its tree: context that can survive or not. */
interface KeyedElement {
  /** Identity group key. */
  key: string;
  /**
   * What must reappear for this to count as surviving context: the key, or
   * (a second entry for the same element) key plus value for read-only
   * types, so Alice's "Phone" cell is not Bob's. Editable values (text
   * fields) and on/off state are left out so typing or flipping a switch
   * doesn't read as a new screen.
   */
  fact: string;
  path: string;
  rect: AxRect;
  /** A heading or navigation-bar title: replacing it means another screen. */
  title: boolean;
  /** Element type, for spotting one text swapped for another in place. */
  type: string;
  /**
   * What the element shows beyond its key: its read-only value, and for an
   * AXUniqueId-keyed text its label. A change here on a uniquely keyed
   * element is a content swap (see {@link screenReplaced}).
   */
  content: string;
}

export interface RefState {
  screen: { width: number; height: number };
  /** Ref'd elements present in the latest tree, in tree order. */
  entries: Map<string, RefEntry>;
  /**
   * Every interesting element of the latest tree by identity group, in tree
   * order, including ones without a ref. Matching judges "one member" and
   * value uniqueness against this, so an offscreen duplicate is never
   * mistaken for a sole survivor.
   */
  groups: Map<string, GroupMember[]>;
  /** The latest tree's uniquely keyed elements in tree order, for judging whether an element's context survived. */
  keyed: KeyedElement[];
  /** Every labelled, identified or value-named key in the latest tree, duplicates included (unqualified). */
  names: Set<string>;
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

/** Types whose value is content (a field's contents on a detail screen), not state the user edits in place. */
const CONTENT_VALUE_TYPES = new Set(["StaticText", "Heading", "Cell", "Row", "Image", "Group", "Other", "Button", "Link"]);

/**
 * Types whose label names what is on screen (a contact's name, a row's
 * title). One of these swapped for another in the same place means other
 * content, see {@link screenReplaced}.
 */
const TEXT_TYPES = new Set(["Heading", "StaticText", "Cell"]);

/** Types keyed by their value when they have no label (SwiftUI/UIKit text exposed as AXValue only). */
const VALUE_NAMED_TYPES = new Set(["Heading", "StaticText"]);

/** Values that are a control's state ("1", "Off"), not content that names a record. */
const STATE_VALUE = /^(0|1|on|off|true|false|yes|no|selected|not selected|checked|unchecked)$/i;

function isContentValue(element: AxElement): boolean {
  return element.value !== "" && CONTENT_VALUE_TYPES.has(element.type) && !STATE_VALUE.test(element.value.trim());
}

function isNavigationBar(element: AxElement): boolean {
  return /navigation ?bar|nav ?bar/i.test(element.type) || /^(navigation|nav) ?bar$/i.test(element.role);
}

function isHeading(element: AxElement): boolean {
  return element.type === "Heading" || element.role.toLowerCase() === "heading";
}

export function isVisibleFrame(frame: AxRect, screen: { width: number; height: number }): boolean {
  if (!(frame.width > 0) || !(frame.height > 0)) return false;
  return frame.x < screen.width && frame.y < screen.height && frame.x + frame.width > 0 && frame.y + frame.height > 0;
}

/** The element's content beyond its key: see {@link KeyedElement.content}. */
function contentOf(element: AxElement): string {
  const value = isContentValue(element) ? element.value : "";
  return hasUniqueId(element) && TEXT_TYPES.has(element.type) ? `${element.label}\u0000${value}` : value;
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
 * `<type>=<value>` for value-only text, else `<type>@` (all unlabelled
 * elements of a type). Values are otherwise excluded so typing into a field
 * reads as a change, not a replacement.
 * A key shared by several elements in one tree (a repeated label or a
 * per-row accessibilityIdentifier) is qualified with the nearest labelled
 * (or identified) ancestor, so "Delete" in Alice's row and "Delete" in Bob's
 * row are separate groups. A group with one member on both sides
 * is the same element; anything else (duplicates, unlabelled elements) is
 * matched by frame, see {@link matchGroup}.
 */
function namedKey(element: AxElement): string | null {
  if (hasUniqueId(element)) return `id:${element.id}`;
  if (element.label !== "") return `${element.type}|${element.label}`;
  if (element.value !== "" && VALUE_NAMED_TYPES.has(element.type)) return `${element.type}=${element.value}`;
  return null;
}

function identityGroups(elements: AxElement[]): Array<{ key: string; unique: boolean }> {
  const base = elements.map((element) => {
    const key = namedKey(element);
    return key ? { key, unique: true, qualify: true } : { key: `${element.type}@`, unique: false, qualify: true };
  });
  const counts = countValues(base.map((group) => group.key));
  const anchorByPath = new Map<string, string>();
  for (const element of elements) {
    const key = namedKey(element);
    if (key) anchorByPath.set(element.path, key);
  }
  return base.map((group, index) => {
    if (!group.qualify || counts.get(group.key)! < 2) return { key: group.key, unique: group.unique };
    let path = elements[index]!.path;
    for (let dot = path.lastIndexOf("."); dot > 0; dot = path.lastIndexOf(".")) {
      path = path.slice(0, dot);
      const anchor = anchorByPath.get(path);
      if (anchor) return { key: `${group.key}^${anchor}`, unique: group.unique };
    }
    return { key: group.key, unique: group.unique };
  });
}

/** Points each frame edge may drift and still name the same element. */
const FRAME_TOLERANCE = 8;
/** How far apart two anchors' offsets may be and still describe one scroll. */
const OFFSET_TOLERANCE = 1;

interface Offset {
  dx: number;
  dy: number;
}

/** `b` is close to `a` once `a` is moved by the container's measured offset. */
function framesClose(a: AxRect, b: AxRect, offset: Offset): boolean {
  return Math.abs(a.x + offset.dx - b.x) <= FRAME_TOLERANCE
    && Math.abs(a.y + offset.dy - b.y) <= FRAME_TOLERANCE
    && Math.abs(a.width - b.width) <= FRAME_TOLERANCE
    && Math.abs(a.height - b.height) <= FRAME_TOLERANCE;
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** An element matched by a unique key (one member on both sides): proof of where content moved. */
interface Anchor {
  path: string;
  offset: Offset;
}

/** Deepest path shared by every member (a lone member's parent). */
function containerPath(members: AxElement[]): string {
  const split = members.map((member) => member.path.split("."));
  const prefix: string[] = [];
  const depth = Math.min(...split.map((parts) => parts.length - 1));
  for (let i = 0; i < depth && split.every((parts) => parts[i] === split[0]![i]); i++) prefix.push(split[0]![i]!);
  return prefix.join(".");
}

/** Tree order of two dotted paths ("0.2" before "0.10"). */
function comparePaths(a: string, b: string): number {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const d = Number(x[i]) - Number(y[i]);
    return Number.isNaN(d) ? x[i]!.localeCompare(y[i]!) : d;
  }
  return x.length - y.length;
}

function inSubtree(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(`${root}.`);
}

interface MeasuredOffset {
  offset: Offset;
  /** False when the container holds no uniquely keyed element on either side. */
  evidence: boolean;
}

/**
 * How far the content holding `members` scrolled, measured from the anchors
 * inside the same container. Null when they disagree, or when the container
 * holds uniquely keyed elements (in either tree) and none of them survived:
 * absent anchors are not proof that nothing moved, a page-sized scroll or a
 * replaced list shows other rows in the same cells. Zero (without evidence)
 * only when the container has no such elements on either side.
 */
function containerOffset(
  key: string,
  members: AxElement[],
  anchors: Anchor[],
  prevKeyed: KeyedElement[],
  currentKeyed: KeyedElement[],
): MeasuredOffset | null {
  const container = containerPath(members);
  const inside = anchors.filter((anchor) => container === "" || anchor.path.startsWith(`${container}.`));
  if (inside.length === 0) {
    // The group's own key doesn't count: a sole survivor of duplicates is keyed in the new tree.
    const keyedInside = (keyed: KeyedElement[]) =>
      keyed.some((k) => k.key !== key && (container === "" || k.path.startsWith(`${container}.`)));
    return keyedInside(prevKeyed) || keyedInside(currentKeyed) ? null : { offset: { dx: 0, dy: 0 }, evidence: false };
  }
  const { offset } = inside[0]!;
  const agree = inside.every((anchor) =>
    Math.abs(anchor.offset.dx - offset.dx) <= OFFSET_TOLERANCE && Math.abs(anchor.offset.dy - offset.dy) <= OFFSET_TOLERANCE);
  return agree ? { offset, evidence: true } : null;
}

/** Ancestor `levels` up from `path` ("" once past the root). */
function ancestorPath(path: string, levels: number): string {
  const parts = path.split(".");
  return parts.slice(0, Math.max(0, parts.length - levels)).join(".");
}

/**
 * The uniquely keyed elements around `path`: level 0 is its own
 * descendants, level n the subtree of its n-th ancestor. The element itself
 * never counts.
 */
function contextAt(keyed: KeyedElement[], path: string, level: number): KeyedElement[] {
  const root = level === 0 ? path : ancestorPath(path, level);
  if (root === "") return keyed.filter((k) => k.path !== path);
  // `keyed` is in tree order, so a subtree is one contiguous run.
  let lo = 0;
  let hi = keyed.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (comparePaths(keyed[mid]!.path, root) < 0) lo = mid + 1;
    else hi = mid;
  }
  const out: KeyedElement[] = [];
  for (let i = lo; i < keyed.length && inSubtree(keyed[i]!.path, root); i++) {
    if (keyed[i]!.path !== path) out.push(keyed[i]!);
  }
  return out;
}

/** Points between two rects' edges (0 when they touch or overlap). */
function rectGap(a: AxRect, b: AxRect): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

/** On the same row: the two rects overlap vertically. */
function sameRow(a: AxRect, b: AxRect): boolean {
  return a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The `count` elements of `list` nearest to `rect` (ties keep tree order). */
function nearestTo(list: KeyedElement[], rect: AxRect, count: number): KeyedElement[] {
  const best: Array<{ k: KeyedElement; gap: number }> = [];
  for (const k of list) {
    const gap = rectGap(k.rect, rect);
    if (best.length === count && gap >= best[count - 1]!.gap) continue;
    let i = best.length;
    while (i > 0 && best[i - 1]!.gap > gap) i--;
    best.splice(i, 0, { k, gap });
    if (best.length > count) best.pop();
  }
  return best.map((b) => b.k);
}

/** How many neighbours nearest by frame must mostly survive. */
const NEIGHBOURS = 3;

function mostSurvived(before: KeyedElement[], after: Set<string>): boolean {
  let survived = 0;
  for (const k of before) if (after.has(k.fact)) survived++;
  return survived * 2 > before.length;
}

/**
 * The first title (tree order) of a scope was replaced: the old one is gone
 * and the new one wasn't there before. A section header scrolling away while
 * the next one stays is not a replacement; Alice's heading becoming Bob's is.
 */
function titleReplaced(before: KeyedElement[], after: KeyedElement[]): boolean {
  const first = (list: KeyedElement[]) => list.find((k) => k.title);
  const a = first(before);
  const b = first(after);
  if (!a || !b) return false;
  return !after.some((k) => k.title && k.fact === a.fact) && !before.some((k) => k.title && k.fact === b.fact);
}

/**
 * Whether the labelled content around an element is still there. All of:
 * - No enclosing scope (own subtree up to the whole screen) had its first
 *   heading or navigation-bar title replaced: refs never carry onto another
 *   record's or another screen's copy of a control, however much shared
 *   chrome (field headers, tab bars) survived.
 * - At the nearest level that holds keyed context, most of the previous
 *   keyed elements survived (a strict majority, with read-only values part
 *   of the fingerprint). For `frame` matches (duplicates, unlabelled
 *   elements) the level counts as soon as either side has context, so a
 *   label that appeared next to an unlabelled button is not proof; for
 *   `label` matches (one labelled or identified element on both sides) only
 *   previous context counts, so an inserted sibling doesn't retire it.
 * - At that level the element's own neighbours survived: most of the
 *   previous keyed elements on the same row, and most of its
 *   {@link NEIGHBOURS} nearest by frame. Sticky chrome sharing a flat
 *   container with replaced rows can't outvote the row the element sits in.
 */
function contextSurvived(
  prevKeyed: KeyedElement[],
  prevPath: string,
  prevRect: AxRect,
  currentKeyed: KeyedElement[],
  currentPath: string,
  mode: "frame" | "label",
): boolean {
  const levels = Math.max(prevPath.split(".").length, currentPath.split(".").length);
  const prevTitles = prevKeyed.filter((k) => k.title);
  const currentTitles = currentKeyed.filter((k) => k.title);
  if (prevTitles.length > 0 && currentTitles.length > 0) {
    for (let level = 0; level <= levels; level++) {
      if (titleReplaced(contextAt(prevTitles, prevPath, level), contextAt(currentTitles, currentPath, level))) return false;
    }
  }
  for (let level = 0; level <= levels; level++) {
    const before = contextAt(prevKeyed, prevPath, level);
    const after = contextAt(currentKeyed, currentPath, level);
    if (before.length === 0 && (mode === "label" || after.length === 0)) continue;
    if (before.length === 0) return false;
    const facts = new Set(after.map((k) => k.fact));
    if (!mostSurvived(before, facts)) return false;
    const row = before.filter((k) => sameRow(k.rect, prevRect));
    if (row.length > 0 && !mostSurvived(row, facts)) return false;
    return mostSurvived(nearestTo(before, prevRect, NEIGHBOURS), facts);
  }
  return true;
}

/** Where the content around a vanished element moved: the offsets worth testing for its replacement. */
function candidateOffsets(anchors: Array<{ path: string; offset: Offset }>, path: string): Offset[] {
  for (let level = 1; ; level++) {
    const root = ancestorPath(path, level);
    const inside = anchors.filter((anchor) => inSubtree(anchor.path, root) && anchor.path !== path);
    if (inside.length > 0) {
      const first = inside[0]!.offset;
      const agree = inside.every((a) =>
        Math.abs(a.offset.dx - first.dx) <= OFFSET_TOLERANCE && Math.abs(a.offset.dy - first.dy) <= OFFSET_TOLERANCE);
      // Disagreeing anchors (a row deleted, sticky chrome over scrolled rows)
      // can't say which way it went: try staying put as well as each of them.
      return agree ? [first] : [{ dx: 0, dy: 0 }, ...inside.map((a) => a.offset)];
    }
    if (root === "") return [{ dx: 0, dy: 0 }];
  }
}

/**
 * The screen now shows other content in the same place: another record,
 * another page of a list, another screen. Any one of these retires every
 * ref, wherever it is, because shared chrome (action buttons, field headers,
 * tab bars, a generic "Contact" title) can't say whose screen it now is, and
 * however much of it survived, a majority vote can't tell chrome from the
 * one label that names the record. Each check needs only one element:
 * - In-place swap: a uniquely keyed text (Heading, StaticText, Cell) vanished,
 *   and a text of the same type that wasn't in the previous tree now sits in
 *   its frame (after the scroll measured from surviving keys around it).
 *   Alice's name becoming Bob's, or a full-page scroll showing other rows.
 * - Content swap: a uniquely keyed element kept its key but shows other
 *   read-only content: a cell, text or button value ("Phone: 555-0001" →
 *   "555-0002"), or an AXUniqueId-keyed text's label. Editable values (text
 *   fields) and on/off state don't count.
 * - Vanished title: a visible heading or navigation-bar title is gone, and
 *   the content around it didn't scroll it offscreen.
 * - Reordered titles: the headings both trees share are in another order.
 * The cost is churn: a counter, clock or status line changing in place
 * retires every ref on the screen. A stale ref beats a tap on another
 * record's button.
 */
function screenReplaced(
  prev: RefState,
  keyed: KeyedElement[],
  names: Set<string>,
  screen: { width: number; height: number },
): boolean {
  const prevByKey = new Map<string, KeyedElement>();
  for (const k of prev.keyed) if (k.fact === k.key) prevByKey.set(k.key, k);
  const currentByKey = new Map<string, KeyedElement>();
  for (const k of keyed) if (k.fact === k.key) currentByKey.set(k.key, k);

  const anchors: Array<{ path: string; offset: Offset }> = [];
  for (const [key, before] of prevByKey) {
    const after = currentByKey.get(key);
    if (!after) continue;
    if (after.content !== before.content) return true;
    anchors.push({ path: before.path, offset: { dx: after.rect.x - before.rect.x, dy: after.rect.y - before.rect.y } });
  }

  const arrived = [...currentByKey.values()].filter((k) => TEXT_TYPES.has(k.type) && !prev.names.has(k.key));
  for (const before of prevByKey.values()) {
    if (currentByKey.has(before.key)) continue;
    // Still there as one of several duplicates: not gone.
    if (names.has(before.key)) continue;
    const swappable = TEXT_TYPES.has(before.type);
    const vanishedTitle = before.title && isVisibleFrame(before.rect, prev.screen);
    if (!swappable && !vanishedTitle) continue;
    for (const offset of candidateOffsets(anchors, before.path)) {
      if (swappable && arrived.some((k) => k.type === before.type && framesClose(before.rect, k.rect, offset))) return true;
      if (vanishedTitle) {
        const moved = { ...before.rect, x: before.rect.x + offset.dx, y: before.rect.y + offset.dy };
        if (isVisibleFrame(moved, screen)) return true;
      }
    }
  }

  const prevTitles = prev.keyed.filter((k) => k.title && k.fact === k.key && currentByKey.get(k.key)?.title).map((k) => k.key);
  const currentTitles = keyed.filter((k) => k.title && k.fact === k.key && prevByKey.get(k.key)?.title).map((k) => k.key);
  return prevTitles.some((key, i) => currentTitles[i] !== key);
}

/**
 * Which previous member (index into `prev`, the group's members in the
 * whole previous tree) each current member continues, or -1 for a new
 * element. Only unambiguous matches carry a ref:
 * - one labelled/identified member on both sides: the same element, wherever
 *   it is, unless its context was replaced (`loneOk`, decided by the caller
 *   with {@link contextSurvived}). Lone matches never use the container
 *   offset (`measured` is null for them): their frame doesn't matter;
 * - one unlabelled member on both sides with a close frame;
 * - same count of duplicates, in order, with equal values and every frame close;
 * - when the count changed: a member whose value is unique on both sides
 *   and whose frame is still close.
 * Frames are compared after the scroll measured by anchors in the same
 * container ({@link containerOffset}), and every frame match also needs its
 * surrounding labels to have survived ({@link contextSurvived}). A uniform
 * shift on its own proves nothing: a reused-cell list that scrolled shows
 * other rows in the same cells. Deleting a row makes its siblings reflow into
 * its slot, so position alone can't say which one survived either. Duplicates
 * with nothing at all to tell them apart (equal values, no keyed element in
 * their container) retire: a scroll by exactly one row would look the same.
 * A stale ref is better than a tap on the wrong element.
 */
function matchGroup(
  prev: GroupMember[],
  current: AxElement[],
  unique: boolean,
  measured: MeasuredOffset | null,
  loneOk: boolean,
  contextOk: (p: number, c: number) => boolean,
): number[] {
  const result = current.map(() => -1);
  if (prev.length === 0) return result;
  if (unique && prev.length === 1 && current.length === 1) return loneOk ? [0] : result;
  if (!measured) return result;
  const { offset } = measured;
  const close = (p: number, c: number) => framesClose(prev[p]!.rect, current[c]!.frame, offset) && contextOk(p, c);
  if (prev.length === 1 && current.length === 1) return close(0, 0) ? [0] : result;
  if (prev.length === current.length
    && prev.every((member, i) => member.value === current[i]!.value && close(i, i))) {
    const indistinguishable = !measured.evidence && new Set(prev.map((member) => member.value)).size === 1;
    return indistinguishable ? result : current.map((_, i) => i);
  }
  const prevValues = countValues(prev.map((member) => member.value));
  const currentValues = countValues(current.map((element) => element.value));
  current.forEach((element, c) => {
    if (prevValues.get(element.value) !== 1 || currentValues.get(element.value) !== 1) return;
    const p = prev.findIndex((member) => member.value === element.value);
    if (close(p, c)) result[c] = p;
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
  const groups = identityGroups(interesting);

  const previousGroups = prev?.groups ?? new Map<string, GroupMember[]>();
  const currentByGroup = new Map<string, number[]>();
  groups.forEach((group, index) => {
    const list = currentByGroup.get(group.key);
    if (list) list.push(index);
    else currentByGroup.set(group.key, [index]);
  });

  const prevKeyed = prev?.keyed ?? [];
  const navigationBars = snapshot.elements.filter(isNavigationBar).map((element) => element.path);
  const isTitle = (element: AxElement) => isHeading(element) || isNavigationBar(element)
    || (element.type === "StaticText" && navigationBars.some((bar) => element.path.startsWith(`${bar}.`)));
  const keyed: KeyedElement[] = [];
  for (const [key, indexes] of currentByGroup) {
    if (indexes.length !== 1 || !groups[indexes[0]!]!.unique) continue;
    const element = interesting[indexes[0]!]!;
    const base = { key, path: element.path, rect: element.frame, type: element.type, content: contentOf(element) };
    keyed.push({ ...base, fact: key, title: isTitle(element) });
    // What it shows is a second fact of its own: Alice's "Phone" value is
    // lost on Bob's screen while the shared "Phone" header survives.
    if (base.content !== "") keyed.push({ ...base, fact: `${key}=${base.content}`, title: false });
  }
  // Tree order, so "first title of a scope" means the topmost in the tree.
  keyed.sort((a, b) => comparePaths(a.path, b.path));

  // Another record or another page in the same place: nothing carries.
  const names = new Set(interesting.map(namedKey).filter((key): key is string => key !== null));
  const replaced = prev !== null && screenReplaced(prev, keyed, names, screen);
  const matchable = replaced ? new Map<string, number[]>() : currentByGroup;

  // Unique keys present once on both sides say how their content moved,
  // unless what surrounded them was replaced (then they aren't the same
  // element). AXUniqueIds get the same check: a React Native testID reused
  // on every detail screen names a different button on each.
  const anchors: Anchor[] = [];
  const loneOk = new Set<string>();
  for (const [key, indexes] of matchable) {
    const previous = previousGroups.get(key);
    if (indexes.length !== 1 || previous?.length !== 1 || !groups[indexes[0]!]!.unique) continue;
    const element = interesting[indexes[0]!]!;
    if (!contextSurvived(prevKeyed, previous[0]!.path, previous[0]!.rect, keyed, element.path, "label")) continue;
    loneOk.add(key);
    const rect = previous[0]!.rect;
    anchors.push({ path: element.path, offset: { dx: element.frame.x - rect.x, dy: element.frame.y - rect.y } });
  }

  const carried = new Map<number, string>();
  for (const [key, indexes] of matchable) {
    const previous = previousGroups.get(key) ?? [];
    const members = indexes.map((i) => interesting[i]!);
    const unique = groups[indexes[0]!]!.unique;
    const lone = unique && previous.length === 1 && members.length === 1;
    const measured = lone ? null : containerOffset(key, members, anchors, prevKeyed, keyed);
    const contextOk = (p: number, c: number) => contextSurvived(prevKeyed, previous[p]!.path, previous[p]!.rect, keyed, members[c]!.path, "frame");
    matchGroup(previous, members, unique, measured, loneOk.has(key), contextOk).forEach((p, i) => {
      const ref = p >= 0 ? previous[p]!.ref : null;
      if (ref) carried.set(indexes[i]!, ref);
    });
  }

  let nextRef = prev?.nextRef ?? 1;
  const entries = new Map<string, RefEntry>();
  const nextGroups = new Map<string, GroupMember[]>();
  interesting.forEach((element, index) => {
    const key = groups[index]!.key;
    const visible = isVisibleFrame(element.frame, screen);
    const existing = carried.get(index);
    let ref: string | null = null;
    if (existing || visible || opts.all) {
      ref = existing ?? `@e${nextRef++}`;
      entries.set(ref, { ref, key, node: compactNode(ref, element, visible), visible, rect: element.frame });
    }
    const member: GroupMember = { ref, path: element.path, value: element.value, rect: element.frame };
    const list = nextGroups.get(key);
    if (list) list.push(member);
    else nextGroups.set(key, [member]);
  });

  const retired = [...(prev?.retired ?? [])];
  for (const entry of prev?.entries.values() ?? []) {
    if (!entries.has(entry.ref)) retired.push(summary(entry));
  }
  if (retired.length > MAX_RETIRED) retired.splice(0, retired.length - MAX_RETIRED);

  return { screen, entries, groups: nextGroups, keyed, names, retired, nextRef };
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
