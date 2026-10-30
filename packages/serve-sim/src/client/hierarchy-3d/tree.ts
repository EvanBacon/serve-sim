// Pure helpers for the /hierarchy-3d outline: class-name shortening, view-kind
// classification, row flattening (with indentation-guide info) and keyboard
// navigation. Kept DOM-free so it can be unit tested.
import type { HierarchyNode } from "../../hierarchy-3d/model";

/**
 * Demangle the common Swift runtime class-name shapes (`_TtC6Places4Card`,
 * nested `_TtCC…`, extensions `_TtCE…CSo…`, generics `_TtGC…`) into their
 * module-less type path. Private discriminators (`P33_<hash>`) and
 * `$`-prefixed local names are dropped. Returns null if it isn't one.
 */
function demangleSwiftClass(name: string): string | null {
  if (!name.startsWith("_Tt")) return null;
  const body = name.slice(3);
  const generic = body.startsWith("G");
  // Each nominal type is a module identifier (or a substitution such as
  // `S_` / `So`) followed by its type path. A run of kind letters (C/V/O; E = extension)
  // right before an identifier starts a new nominal; when that run is pure
  // kind letters the identifier is the module and is dropped, so generic
  // arguments (`…V6Places8RootView_`) don't leak their module.
  const nominals: string[][] = [];
  let i = 0;
  let run = "";
  while (i < body.length) {
    const ch = body[i]!;
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < body.length && body[j]! >= "0" && body[j]! <= "9") j++;
      const len = Number(body.slice(i, j));
      const ident = body.slice(j, j + len);
      if (ident.length !== len || len === 0) return null;
      const privateDiscriminator = body[i - 1] === "P" && (/^_[0-9A-F]{32}$/.test(ident) || ident.startsWith("$"));
      const kinds = run.replace(/^G/, "");
      if (/[CVO]/.test(kinds)) {
        nominals.push([]);
        if (!/^[CVOE]+$/.test(kinds) && !privateDiscriminator) nominals[nominals.length - 1]!.push(ident);
      } else if (!privateDiscriminator && nominals.length > 0) {
        nominals[nominals.length - 1]!.push(ident);
      }
      run = "";
      i = j + len;
    } else {
      run += ch;
      i++;
    }
  }
  const paths = nominals.filter((p) => p.length > 0).map((p) => p.join("."));
  if (paths.length === 0) return null;
  if (generic && paths.length > 1) return `${paths[0]}<${paths.slice(1).join(", ")}>`;
  return paths[0]!;
}

/**
 * Primary outline label for a class: no Swift module prefix
 * ("Places.HeaderView" -> "HeaderView", "UIKit.ScrollEdgeEffectView" ->
 * "ScrollEdgeEffectView") and mangled runtime names demangled.
 */
export function shortClassName(name: string): string {
  const demangled = demangleSwiftClass(name);
  if (demangled) return demangled;
  // Strip the module before the first top-level dot (outside generics).
  const lt = name.indexOf("<");
  const head = lt >= 0 ? name.slice(0, lt) : name;
  const dot = head.indexOf(".");
  return dot > 0 && dot < head.length - 1 ? name.slice(dot + 1) : name;
}

export type NodeKind = "window" | "text" | "image" | "control" | "scroll" | "view";

const KIND_BY_CLASS: [NodeKind, string[]][] = [
  ["window", ["UIWindow", "Window", "Application"]],
  ["text", ["UILabel", "UITextView", "UITextField", "StaticText", "Heading", "TextField", "TextView", "SecureTextField"]],
  ["image", ["UIImageView", "Image", "Icon"]],
  ["scroll", ["UIScrollView", "ScrollView", "Table", "CollectionView", "List"]],
  ["control", ["UIControl", "Button", "Link", "Switch", "Slider", "Toggle", "SegmentedControl", "Tab", "TabBar", "Stepper", "Picker"]],
];

/** Coarse kind for the outline's type glyph (Xcode-style). */
export function nodeKind(node: Pick<HierarchyNode, "class" | "superclasses">): NodeKind {
  const chain = [node.class, ...node.superclasses];
  for (const cls of chain) {
    for (const [kind, names] of KIND_BY_CLASS) if (names.includes(cls)) return kind;
  }
  return "view";
}

/** Secondary detail shown after the class: accessibility id, text/title, or label. */
export function nodeSummary(node: HierarchyNode): string {
  const p = node.props;
  const text = typeof p.text === "string" ? p.text : typeof p.title === "string" ? p.title : "";
  return node.accessibilityIdentifier || text || node.accessibilityLabel || "";
}

export interface TreeRow {
  node: HierarchyNode;
  /** Indentation level; one guide line is drawn per ancestor level. */
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
  /** When filtering: an ancestor shown only as context for a match. */
  context: boolean;
}

function matches(n: HierarchyNode, f: string): boolean {
  const hay = `${n.class} ${shortClassName(n.class)} ${n.accessibilityIdentifier ?? ""} ${n.accessibilityLabel ?? ""} ${nodeSummary(n)} ${n.viewController ?? ""}`;
  return hay.toLowerCase().includes(f);
}

/**
 * Visible outline rows. With a filter, every match is shown together with its
 * ancestor chain (marked `context`) so indentation keeps its meaning. The
 * collapsed state is ignored and rows have no disclosure while filtering.
 */
export function flattenTree(windows: HierarchyNode[], collapsed: ReadonlySet<string>, filter = ""): TreeRow[] {
  const rows: TreeRow[] = [];
  const f = filter.trim().toLowerCase();
  if (f) {
    // Returns whether the subtree contains a match; rows are emitted in order.
    const visit = (n: HierarchyNode, depth: number, parentId: string | null): boolean => {
      const self = matches(n, f);
      const at = rows.length;
      // No disclosure while filtering: the result set decides what's shown.
      rows.push({ node: n, depth, parentId, hasChildren: false, expanded: false, context: !self });
      let any = false;
      for (const c of n.children) if (visit(c, depth + 1, n.id)) any = true;
      if (!self && !any) rows.length = at;
      return self || any;
    };
    for (const w of windows) visit(w, 0, null);
    return rows;
  }
  const visit = (n: HierarchyNode, depth: number, parentId: string | null) => {
    const expanded = n.children.length > 0 && !collapsed.has(n.id);
    rows.push({ node: n, depth, parentId, hasChildren: n.children.length > 0, expanded, context: false });
    if (expanded) for (const c of n.children) visit(c, depth + 1, n.id);
  };
  for (const w of windows) visit(w, 0, null);
  return rows;
}

/** Ids of `node` and every descendant that has children (for Option-click). */
export function expandableSubtreeIds(node: HierarchyNode): string[] {
  const out: string[] = [];
  const visit = (n: HierarchyNode) => {
    if (n.children.length === 0) return;
    out.push(n.id);
    n.children.forEach(visit);
  };
  visit(node);
  return out;
}

export type TreeKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export type TreeAction = { select: string } | { expand: string } | { collapse: string } | null;

/**
 * Finder/Xcode outline keyboard behavior. Up/Down move through visible rows,
 * Left collapses an expanded row or moves to its parent, Right expands a
 * collapsed row or moves to its first child. With nothing selected, any
 * movement key selects the first (End: last) row.
 */
export function treeKeyAction(rows: TreeRow[], selectedId: string | null, key: TreeKey): TreeAction {
  if (rows.length === 0) return null;
  const index = selectedId ? rows.findIndex((r) => r.node.id === selectedId) : -1;
  if (index < 0) return { select: (key === "End" ? rows[rows.length - 1]! : rows[0]!).node.id };
  const row = rows[index]!;
  switch (key) {
    case "ArrowUp":
      return index > 0 ? { select: rows[index - 1]!.node.id } : null;
    case "ArrowDown":
      return index < rows.length - 1 ? { select: rows[index + 1]!.node.id } : null;
    case "Home":
      return index > 0 ? { select: rows[0]!.node.id } : null;
    case "End":
      return index < rows.length - 1 ? { select: rows[rows.length - 1]!.node.id } : null;
    case "ArrowLeft":
      if (row.hasChildren && row.expanded) return { collapse: row.node.id };
      return row.parentId ? { select: row.parentId } : null;
    case "ArrowRight":
      if (row.hasChildren && !row.expanded) return { expand: row.node.id };
      if (row.expanded && rows[index + 1]?.parentId === row.node.id) return { select: rows[index + 1]!.node.id };
      return null;
  }
}

/**
 * Initial collapsed set for a fresh capture: the top `openDepth` levels stay
 * open, and so do single-child chains (UIKit wraps content in many of them),
 * so the outline opens shallow but without a click per wrapper.
 */
export function initialCollapsed(windows: HierarchyNode[], openDepth = 2): Set<string> {
  const out = new Set<string>();
  const visit = (n: HierarchyNode, depth: number) => {
    if (n.children.length === 0) return;
    // Keep descending: revealing a selection re-opens only its ancestors.
    if (depth >= openDepth && n.children.length > 1) out.add(n.id);
    for (const c of n.children) visit(c, depth + 1);
  };
  for (const w of windows) visit(w, 0);
  return out;
}

/** Id and parent lookups over the full captured tree (including views the layout skips). */
export function indexTree(windows: HierarchyNode[]): { byId: Map<string, HierarchyNode>; parentById: Map<string, string | null> } {
  const byId = new Map<string, HierarchyNode>();
  const parentById = new Map<string, string | null>();
  const visit = (n: HierarchyNode, parent: string | null) => {
    byId.set(n.id, n);
    parentById.set(n.id, parent);
    for (const c of n.children) visit(c, n.id);
  };
  for (const w of windows) visit(w, null);
  return { byId, parentById };
}

/** Ancestor ids of `id`, outermost first (excluding `id` itself). */
export function ancestorChain(parentById: ReadonlyMap<string, string | null>, id: string): string[] {
  const out: string[] = [];
  let p = parentById.get(id) ?? null;
  while (p) {
    out.unshift(p);
    p = parentById.get(p) ?? null;
  }
  return out;
}
