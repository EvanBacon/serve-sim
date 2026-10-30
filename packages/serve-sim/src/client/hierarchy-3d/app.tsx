import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ancestorIds, layoutHierarchy, type DepthMode, type Layout } from "../../hierarchy-3d/layout";
import type { HierarchyCaptureResponse, HierarchyNode, HierarchyPropValue, HierarchyRect } from "../../hierarchy-3d/model";
import { ChevronIcon, ClearIcon, ClipIcon, KindIcon, LayersIcon, RefreshIcon, ResetViewIcon, SearchIcon } from "./icons";
import { OverflowMenu, type MenuEntry } from "./overflow-menu";
import { fitDistance, panTarget, type OrbitCamera } from "./projection";
import { HierarchyScene } from "./scene";
import { expandableSubtreeIds, flattenTree, initialCollapsed, nodeKind, nodeSummary, shortClassName, treeKeyAction, type TreeKey, type TreeRow } from "./tree";

export interface Hierarchy3dConfig {
  basePath: string;
  device: string | null;
}

const DEFAULT_YAW = -32;
const DEFAULT_PITCH = 14;

function readParams() {
  const p = new URLSearchParams(location.search);
  const num = (k: string) => {
    const v = p.get(k);
    return v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
  };
  return {
    orbit: p.get("orbit") === "1",
    select: p.get("select"),
    yaw: num("yaw"),
    pitch: num("pitch"),
    spacing: num("spacing"),
    zoom: num("zoom"),
  };
}

function useResolvedTheme(): "light" | "dark" {
  const read = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function fmtRect(r: HierarchyRect | undefined): string {
  return r ? `(${fmt(r.x)}, ${fmt(r.y)}, ${fmt(r.width)}, ${fmt(r.height)})` : "—";
}
function fmtColor(c: [number, number, number, number] | number[] | null): string {
  if (!c || c.length !== 4) return "clear";
  const [r, g, b, a] = c.map((v) => Math.round(v! * 255)) as [number, number, number, number];
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
}
/** Compact color label for the inspector: hex, plus alpha when translucent. */
function fmtColorShort(c: [number, number, number, number] | null): string {
  if (!c) return "clear";
  const hex = c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
  return c[3] >= 0.995 ? `#${hex}` : `#${hex} · ${Math.round(c[3] * 100)}%`;
}
function fmtProp(v: HierarchyPropValue): string {
  if (Array.isArray(v)) return v.length === 4 ? fmtColor(v) : `[${v.map(fmt).join(", ")}]`;
  if (typeof v === "number") return fmt(v);
  return String(v);
}

/** Whether a view draws anything itself (vs. being a transparent container). */
function nodeHasContent(node: HierarchyNode): boolean {
  return node.snapshot !== undefined || (node.backgroundColor !== null && node.backgroundColor[3] > 0.01);
}

function autoSpacing(screenHeight: number, maxLevel: number): number {
  if (maxLevel <= 0) return 30;
  return Math.round(Math.min(40, Math.max(6, (screenHeight * 0.8) / maxLevel)));
}

/** Camera distance that frames the screen plus the exploded stack at the default angle. */
function fittedDistance(screen: { width: number; height: number }, canvas: HTMLCanvasElement, stackDepth: number): number {
  const aspect = Math.max(0.2, canvas.clientWidth / Math.max(1, canvas.clientHeight));
  const yaw = (Math.abs(DEFAULT_YAW) * Math.PI) / 180;
  const apparentWidth = screen.width * Math.cos(yaw) + stackDepth * Math.sin(yaw);
  return fitDistance(apparentWidth, screen.height, aspect) * 1.1;
}

const TREE_WIDTH_KEY = "serve-sim.hierarchy-3d.treeWidth";
const TREE_WIDTH_DEFAULT = 300;
const TREE_WIDTH_MIN = 200;
const TREE_WIDTH_MAX = 640;
const INDENT = 14; // keep in sync with .h3d-guides in hierarchy-3d.css

function clampTreeWidth(w: number): number {
  return Math.round(Math.max(TREE_WIDTH_MIN, Math.min(TREE_WIDTH_MAX, Math.min(w, window.innerWidth - 480))));
}

function readTreeWidth(): number {
  try {
    const v = Number(localStorage.getItem(TREE_WIDTH_KEY));
    return Number.isFinite(v) && v > 0 ? clampTreeWidth(v) : TREE_WIDTH_DEFAULT;
  } catch {
    return TREE_WIDTH_DEFAULT;
  }
}

/** Deep rows keep room for a readable label; the outline scrolls sideways past that. */
const rowMinWidth = (depth: number) => depth * INDENT + 190;

const TREE_KEYS = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

export function App({ config }: { config: Hierarchy3dConfig }) {
  const params = useMemo(readParams, []);
  const theme = useResolvedTheme();
  const api = `${config.basePath}/hierarchy-3d/api`;
  const deviceQuery = config.device ? `device=${encodeURIComponent(config.device)}` : "";

  const [response, setResponse] = useState<HierarchyCaptureResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [injecting, setInjecting] = useState(false);

  // null = automatic: spread the stack to roughly the screen's height.
  const [spacingOverride, setSpacing] = useState<number | null>(params.spacing);
  const [compact, setCompact] = useState(true);
  const [mode, setMode] = useState<DepthMode>("overlap");
  const [clip, setClip] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [textures, setTextures] = useState(true);
  const [outlines, setOutlines] = useState(true);
  const [orbiting, setOrbiting] = useState(params.orbit);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(-1);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [treeWidth, setTreeWidth] = useState(readTreeWidth);
  const treeRef = useRef<HTMLDivElement | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<HierarchyScene | null>(null);
  const cameraRef = useRef<OrbitCamera>({ yaw: params.yaw ?? DEFAULT_YAW, pitch: params.pitch ?? DEFAULT_PITCH, distance: 1500, target: [0, 0, 0] });
  const frameRef = useRef(0);
  const drawRef = useRef<() => void>(() => {});
  const fittedFor = useRef<string | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [textureProgress, setTextureProgress] = useState<{ loaded: number; total: number }>({ loaded: 0, total: 0 });

  const capture = response?.capture ?? null;

  // Only the newest request may update state: an older capture finishing
  // late must not replace a newer one (its textures may be evicted already).
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${api}/capture?${deviceQuery}`, { cache: "no-store" });
      const body = (await res.json()) as HierarchyCaptureResponse & { message?: string };
      if (seq !== loadSeq.current) return;
      if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      setResponse(body);
      if (body.error && !body.capture) setError(body.error);
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [api, deviceQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const layout: Layout | null = useMemo(() => {
    if (!capture) return null;
    // Accessibility nodes are all textured from the screenshot, so all count.
    const hasContent = compact && capture.source === "injected" ? nodeHasContent : undefined;
    return layoutHierarchy(capture.windows, { mode, clip, showHidden, ...(hasContent ? { hasContent } : {}) });
  }, [capture, mode, clip, showHidden, compact]);
  const maxLevel = layout?.maxLevel ?? 0;
  const spacing = spacingOverride ?? autoSpacing(capture?.screen.height ?? 800, maxLevel);
  const sceneLayout = useRef<Layout | null>(null);
  sceneLayout.current = layout;
  const selectedIndex = selectedId && layout ? layout.indexById.get(selectedId) ?? -1 : -1;

  const nodeById = useMemo(() => {
    const map = new Map<string, HierarchyNode>();
    const visit = (n: HierarchyNode) => {
      map.set(n.id, n);
      n.children.forEach(visit);
    };
    capture?.windows.forEach(visit);
    return map;
  }, [capture]);
  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;

  // Initial selection from ?select=<id | accessibilityIdentifier>, applied
  // once (not again after the user deselects and refreshes).
  const initialSelectApplied = useRef(false);
  useEffect(() => {
    if (!params.select || !capture || initialSelectApplied.current) return;
    for (const n of nodeById.values()) {
      if (n.id === params.select || n.accessibilityIdentifier === params.select) {
        initialSelectApplied.current = true;
        setSelectedId(n.id);
        break;
      }
    }
  }, [capture, nodeById, params.select]);

  // Scene lifecycle.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let scene: HierarchyScene;
    try {
      // Textures arrive one by one; coalesce progress updates so dozens of
      // loads don't each re-render the page.
      let progressTimer: ReturnType<typeof setTimeout> | null = null;
      scene = new HierarchyScene(canvas, () => {
        drawRef.current();
        progressTimer ??= setTimeout(() => {
          progressTimer = null;
          if (sceneRef.current === scene) setTextureProgress(scene.textureProgress());
        }, 150);
      });
    } catch (e) {
      setSceneError(e instanceof Error ? e.message : String(e));
      return;
    }
    sceneRef.current = scene;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frameRef.current);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const sceneOptions = useMemo(
    () => ({ spacing, textures, outlines, minLevel: 0, maxLevel, selected: selectedIndex, hovered, theme }),
    [spacing, textures, outlines, maxLevel, selectedIndex, hovered, theme],
  );
  const optionsRef = useRef(sceneOptions);
  optionsRef.current = sceneOptions;

  drawRef.current = () => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => sceneRef.current?.render(cameraRef.current, optionsRef.current));
  };

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !capture || !layout) return;
    scene.setLayout(capture, layout);
    setTextureProgress(scene.textureProgress());
    // Fit the camera once per app/screen size, not on every refresh.
    const key = `${capture.bundleId}:${capture.screen.width}x${capture.screen.height}`;
    if (fittedFor.current !== key) {
      fittedFor.current = key;
      cameraRef.current.distance = fittedDistance(capture.screen, canvasRef.current!, layout.maxLevel * optionsRef.current.spacing) / (params.zoom ?? 1);
    }
    drawRef.current();
  }, [capture, layout, params.zoom]);

  useEffect(() => {
    drawRef.current();
  }, [sceneOptions]);

  // Auto-orbit: a gentle swing around the stack (also handy for recordings).
  useEffect(() => {
    if (!orbiting) return;
    let raf = 0;
    const start = performance.now();
    const baseYaw = cameraRef.current.yaw;
    const phase = Math.asin(Math.max(-1, Math.min(1, baseYaw / 50)));
    const tick = (t: number) => {
      const s = (t - start) / 1000;
      cameraRef.current.yaw = 50 * Math.sin(phase + s * 0.55);
      cameraRef.current.pitch = DEFAULT_PITCH + 8 * Math.sin(s * 0.3);
      sceneRef.current?.render(cameraRef.current, optionsRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [orbiting]);

  const resetCamera = useCallback(() => {
    cameraRef.current.yaw = DEFAULT_YAW;
    cameraRef.current.pitch = DEFAULT_PITCH;
    cameraRef.current.target = [0, 0, 0];
    if (capture && canvasRef.current) {
      cameraRef.current.distance = fittedDistance(capture.screen, canvasRef.current, (layout?.maxLevel ?? 0) * optionsRef.current.spacing);
    }
    drawRef.current();
  }, [capture, layout]);

  const frontView = useCallback(() => {
    setOrbiting(false);
    cameraRef.current.yaw = 0;
    cameraRef.current.pitch = 0;
    drawRef.current();
  }, []);

  // Pointer interactions on the canvas: drag = orbit, shift/right/middle drag
  // = pan, wheel/pinch = zoom, click = select, double-click = reset.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let drag: { x: number; y: number; moved: boolean; pan: boolean; id: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, moved: false, pan: e.shiftKey || e.altKey || e.button === 1 || e.button === 2, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (!drag) {
        const idx = sceneRef.current?.pick(e.clientX - rect.left, e.clientY - rect.top) ?? -1;
        setHovered((prev) => (prev === idx ? prev : idx));
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved) setOrbiting(false);
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const cam = cameraRef.current;
      if (drag.pan) {
        cam.target = panTarget(cam, dx, dy, canvas.clientHeight);
        drawRef.current();
      } else {
        cam.yaw -= dx * 0.4;
        cam.pitch = Math.max(-89, Math.min(89, cam.pitch + dy * 0.4));
        drawRef.current();
      }
    };
    const up = (e: PointerEvent) => {
      if (!drag) return;
      const wasClick = !drag.moved && e.button === 0;
      drag = null;
      if (wasClick) {
        const rect = canvas.getBoundingClientRect();
        const idx = sceneRef.current?.pick(e.clientX - rect.left, e.clientY - rect.top) ?? -1;
        const item = idx >= 0 ? sceneLayout.current?.items[idx] : undefined;
        setSelectedId(item ? item.node.id : null);
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = cameraRef.current;
      const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      cam.distance = Math.max(100, Math.min(20000, cam.distance * factor));
      drawRef.current();
    };
    const leave = () => setHovered(-1);
    const context = (e: Event) => e.preventDefault();
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("dblclick", resetCamera);
    canvas.addEventListener("contextmenu", context);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("dblclick", resetCamera);
      canvas.removeEventListener("contextmenu", context);
    };
  }, [resetCamera]);

  // Open a fresh app's outline shallow (refreshes keep the user's expansion).
  const collapsedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!capture) return;
    const key = `${capture.source}:${capture.bundleId}`;
    if (collapsedFor.current === key) return;
    collapsedFor.current = key;
    setCollapsed(initialCollapsed(capture.windows));
  }, [capture]);

  // Keep the selection visible in the tree.
  useEffect(() => {
    if (!selectedId || !layout) return;
    const path = ancestorIds(layout, selectedId).slice(0, -1);
    setCollapsed((prev) => {
      if (!path.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      path.forEach((id) => next.delete(id));
      return next;
    });
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(selectedId)}"]`);
      const list = treeRef.current;
      if (!row || !list) return;
      row.scrollIntoView({ block: "nearest" });
      // Deep rows: scroll sideways only when the start of the selected
      // row's label (chevron + glyph + ~60px of name) would be hidden.
      const indent = (Number(row.getAttribute("aria-level") ?? 1) - 1) * INDENT;
      const labelEnd = indent + 100;
      if (indent < list.scrollLeft || labelEnd > list.scrollLeft + list.clientWidth) {
        list.scrollLeft = Math.max(0, labelEnd - list.clientWidth + 2 * INDENT);
      }
    });
  }, [selectedId, layout]);

  const rows = useMemo(() => (capture ? flattenTree(capture.windows, collapsed, filter) : []), [capture, collapsed, filter]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const setExpanded = useCallback((ids: string[], expand: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (expand) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);

  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const nodeByIdRef = useRef(nodeById);
  nodeByIdRef.current = nodeById;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // Option-click toggles the whole subtree, like Finder / Xcode.
  const toggleCollapsed = useCallback((id: string, deep: boolean) => {
    const expand = collapsedRef.current.has(id);
    const node = nodeByIdRef.current.get(id);
    setExpanded(deep && node ? expandableSubtreeIds(node) : [id], expand);
  }, [setExpanded]);

  // Outline keyboard navigation. Arrows drive the tree wherever focus is
  // (except text fields and the menu), so they also work after clicking the
  // canvas; Left walks up to the superview once a row is collapsed.
  const navigateTree = useCallback((key: TreeKey) => {
    const action = treeKeyAction(rowsRef.current, selectedIdRef.current, key);
    if (!action) return;
    if ("select" in action) setSelectedId(action.select);
    else if ("expand" in action) setExpanded([action.expand], true);
    else setExpanded([action.collapse], false);
  }, [setExpanded]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (target?.closest('input, select, textarea, [role="menu"], [role="separator"]')) return;
      if (e.key === "r") void load();
      else if (e.key === "f") resetCamera();
      else if (e.key === "Escape") setSelectedId(null);
      else if (TREE_KEYS.has(e.key)) {
        e.preventDefault();
        navigateTree(e.key as TreeKey);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [load, resetCamera, navigateTree]);

  const onFilterKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      treeRef.current?.focus();
      navigateTree("ArrowDown");
    } else if (e.key === "Escape" && filter) {
      e.stopPropagation();
      setFilter("");
    }
  };

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = treeWidth;
    const move = (ev: PointerEvent) => setTreeWidth(clampTreeWidth(startW + ev.clientX - startX));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  useEffect(() => {
    try {
      localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth));
    } catch {}
    drawRef.current();
  }, [treeWidth]);

  const inject = async () => {
    const bundleId = response?.foreground?.bundleId;
    if (!bundleId) return;
    setInjecting(true);
    setError(null);
    try {
      const res = await fetch(`${api}/inject?${deviceQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId }),
      });
      const body = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      // Give the relaunched app a moment to draw its first screen.
      await new Promise((r) => setTimeout(r, 1200));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInjecting(false);
    }
  };

  const hoveredNode = hovered >= 0 ? layout?.items[hovered]?.node ?? null : null;
  const hoveredId = hoveredNode?.id ?? null;
  const selectedItem = selectedIndex >= 0 ? layout?.items[selectedIndex] : undefined;
  const appName = capture?.bundleId ?? response?.foreground?.bundleId ?? null;

  const menuEntries: MenuEntry[] = [
    { type: "check", label: "Snapshots", checked: textures, onChange: setTextures, hint: "Texture each layer with the view's pixels" },
    { type: "check", label: "Wireframes", checked: outlines, onChange: setOutlines, hint: "Outline every view" },
    { type: "check", label: "Collapse transparent containers", checked: compact, onChange: setCompact, hint: "Views that draw nothing don't take a layer" },
    { type: "check", label: "Show hidden views", checked: showHidden, onChange: setShowHidden },
    { type: "separator" },
    { type: "heading", label: "Depth" },
    { type: "radio", label: "By overlap", checked: mode === "overlap", onSelect: () => setMode("overlap") },
    { type: "radio", label: "By tree depth", checked: mode === "tree", onSelect: () => setMode("tree") },
    { type: "separator" },
    { type: "action", label: "Front view", onSelect: frontView },
    { type: "check", label: "Auto-orbit", checked: orbiting, onChange: setOrbiting },
  ];

  return (
    <div className="h3d-root">
      <header className="h3d-toolbar">
        <div className="h3d-title">
          <h1>View Hierarchy</h1>
          {appName && <span className="h3d-app" title={appName}>{appName}</span>}
          <span className="h3d-pill">Experimental</span>
        </div>
        <div className="h3d-controls">
          <button
            type="button" className="h3d-icon-btn" onClick={() => void load()} disabled={loading}
            title="Refresh (R)" aria-label="Refresh" aria-busy={loading}
          >
            <span className={loading ? "h3d-spin" : undefined}><RefreshIcon /></span>
          </button>
          <label className="h3d-spacing" title="Layer spacing (double-click to reset)">
            <LayersIcon />
            <input
              type="range" min={0} max={120} value={spacing} aria-label="Layer spacing"
              onInput={(e) => setSpacing(Number((e.target as HTMLInputElement).value))}
              onDoubleClick={() => setSpacing(null)}
            />
          </label>
          <button
            type="button" className="h3d-icon-btn" aria-pressed={!clip} onClick={() => setClip((c) => !c)}
            title="Show clipped content" aria-label="Show clipped content"
          >
            <ClipIcon />
          </button>
          <button type="button" className="h3d-icon-btn" onClick={resetCamera} title="Reset view (F)" aria-label="Reset view">
            <ResetViewIcon />
          </button>
          <span className="h3d-toolbar-sep" />
          <OverflowMenu entries={menuEntries} footer={<Shortcuts />} />
        </div>
      </header>

      {(response?.notice || error) && (
        <div className={`h3d-banner${error ? " h3d-banner-error" : ""}`} role={error ? "alert" : "status"}>
          <span>{error ?? response?.notice}</span>
          {response?.canInject && response.foreground && response.capture?.source !== "injected" && (
            <button type="button" className="h3d-btn" onClick={() => void inject()} disabled={injecting}>
              {injecting ? "Relaunching…" : `Relaunch ${response.foreground.bundleId} with inspector`}
            </button>
          )}
        </div>
      )}

      <div className="h3d-main" style={{ gridTemplateColumns: `${treeWidth}px minmax(0, 1fr) 300px` }}>
        <aside className="h3d-tree" aria-label="View hierarchy">
          <div className="h3d-search">
            <SearchIcon />
            <input
              type="text" placeholder="Filter" aria-label="Filter views" spellCheck={false} value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
              onKeyDown={onFilterKeyDown}
            />
            {filter && (
              <button type="button" className="h3d-search-clear" aria-label="Clear filter" onClick={() => setFilter("")}>
                <ClearIcon />
              </button>
            )}
          </div>
          <TreeList
            treeRef={treeRef}
            rows={rows}
            selectedId={selectedId}
            hoveredId={hoveredId}
            layout={layout}
            onSelect={setSelectedId}
            onHover={setHovered}
            onToggle={toggleCollapsed}
          />
          {filter && rows.length === 0 && capture && <div className="h3d-tree-empty">No matches</div>}
          {capture && (
            <footer className="h3d-status">
              <span>{capture.nodeCount} views{capture.truncated ? " (truncated)" : ""}</span>
              <span title={capture.source === "injected" ? "Captured by the injected UIKit agent" : "Accessibility tree (inject the agent for classes, colors and per-view snapshots)"}>
                {capture.source === "injected" ? "UIKit" : "Accessibility"}
              </span>
              {capture.durationMs != null && <span>{Math.round(capture.durationMs)} ms</span>}
            </footer>
          )}
          <div
            className="h3d-splitter" role="separator" aria-orientation="vertical" aria-label="Resize hierarchy panel"
            aria-valuemin={TREE_WIDTH_MIN} aria-valuemax={TREE_WIDTH_MAX} aria-valuenow={treeWidth} tabIndex={0}
            onPointerDown={startResize}
            onDoubleClick={() => setTreeWidth(clampTreeWidth(TREE_WIDTH_DEFAULT))}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                setTreeWidth((w) => clampTreeWidth(w + (e.key === "ArrowLeft" ? -16 : 16)));
              }
            }}
          />
        </aside>

        <section className="h3d-viewport">
          <canvas ref={canvasRef} className="h3d-canvas" />
          {sceneError && <div className="h3d-overlay">{sceneError}</div>}
          {!capture && !sceneError && <div className="h3d-overlay">{loading ? "Capturing view hierarchy…" : error ?? "No hierarchy yet."}</div>}
          {hoveredNode && (
            <div className="h3d-chip h3d-hover">
              <KindIcon kind={nodeKind(hoveredNode)} />
              <span className="h3d-chip-name">{shortClassName(hoveredNode.class)}</span>
              {nodeSummary(hoveredNode) && <span className="h3d-chip-detail">{nodeSummary(hoveredNode)}</span>}
            </div>
          )}
          {textures && textureProgress.total > 0 && textureProgress.loaded < textureProgress.total && (
            <div className="h3d-chip h3d-progress">Loading snapshots {textureProgress.loaded}/{textureProgress.total}</div>
          )}
          {capture && <div className="h3d-hint">Drag to orbit · Shift-drag to pan · Scroll to zoom</div>}
        </section>

        <aside className="h3d-inspector" aria-label="Inspector">
          {selectedNode ? (
            <Inspector node={selectedNode} level={selectedItem?.level ?? null} visible={selectedItem?.visibleRect ?? null} onSelectParent={
              selectedItem && selectedItem.parent >= 0 ? () => setSelectedId(layout!.items[selectedItem.parent]!.node.id) : undefined
            } />
          ) : (
            <div className="h3d-empty">No Selection</div>
          )}
        </aside>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Drag", "Orbit"],
  ["⇧ Drag", "Pan"],
  ["Scroll", "Zoom"],
  ["Double-click", "Reset view"],
  ["R", "Refresh"],
  ["F", "Reset view"],
  ["↑ ↓", "Move selection"],
  ["← →", "Collapse · expand"],
  ["⌥ Click ▸", "Toggle subtree"],
  ["Esc", "Deselect"],
];

function Shortcuts() {
  return (
    <div className="h3d-shortcuts">
      <div className="h3d-menu-heading">Shortcuts</div>
      <dl>
        {SHORTCUTS.map(([k, v]) => (
          <div key={k + v}>
            <dt><kbd className="h3d-kbd">{k}</kbd></dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Memoized, with memoized rows: 3D hover and texture-progress re-renders skip
 * it entirely, and a hover / selection change only re-renders the rows whose
 * state flipped.
 */
const TreeList = memo(function TreeList({ treeRef, rows, selectedId, hoveredId, layout, onSelect, onHover, onToggle }: {
  treeRef: { current: HTMLDivElement | null };
  rows: TreeRow[];
  selectedId: string | null;
  hoveredId: string | null;
  layout: Layout | null;
  onSelect: (id: string) => void;
  onHover: (index: number) => void;
  onToggle: (id: string, deep: boolean) => void;
}) {
  return (
    <div
      ref={treeRef}
      className="h3d-rows"
      role="tree"
      aria-label="Views"
      tabIndex={0}
      aria-activedescendant={selectedId ? `h3d-row-${selectedId}` : undefined}
      onMouseLeave={() => onHover(-1)}
    >
      {rows.map((row) => (
        <TreeRowView
          key={row.node.id}
          row={row}
          selected={row.node.id === selectedId}
          hovered={row.node.id === hoveredId}
          layoutIndex={layout?.indexById.get(row.node.id) ?? -1}
          onSelect={onSelect}
          onHover={onHover}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
});

const TreeRowView = memo(function TreeRowView({ row, selected, hovered, layoutIndex, onSelect, onHover, onToggle }: {
  row: TreeRow;
  selected: boolean;
  hovered: boolean;
  layoutIndex: number;
  onSelect: (id: string) => void;
  onHover: (index: number) => void;
  onToggle: (id: string, deep: boolean) => void;
}) {
  const { node, depth, hasChildren, expanded, context } = row;
  const summary = nodeSummary(node);
  const name = shortClassName(node.class);
  const notDrawn = layoutIndex < 0;
  return (
    <div
      id={`h3d-row-${node.id}`}
      data-node-id={node.id}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={hasChildren ? expanded : undefined}
      style={{ minWidth: rowMinWidth(depth) }}
      className={`h3d-row${selected ? " is-selected" : ""}${hovered ? " is-hovered" : ""}${notDrawn ? " is-dim" : ""}${context ? " is-context" : ""}`}
      title={`${node.class}${summary ? ` — ${summary}` : ""}${notDrawn ? " (not drawn)" : ""}`}
      onClick={() => onSelect(node.id)}
      onMouseEnter={() => onHover(layoutIndex)}
    >
      {depth > 0 && <span className="h3d-guides" style={{ width: depth * INDENT }} />}
      <span
        className={`h3d-disclosure${expanded ? " is-open" : ""}`}
        onClick={(e) => {
          if (!hasChildren) return;
          e.stopPropagation();
          onToggle(node.id, e.altKey);
        }}
      >
        {hasChildren ? <ChevronIcon /> : null}
      </span>
      <KindIcon kind={nodeKind(node)} />
      <span className="h3d-class">{name}</span>
      {summary && <span className="h3d-summary">{summary}</span>}
    </div>
  );
});

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="h3d-k">{k}</dt>
      <dd className={`h3d-v${mono ? " h3d-mono" : ""}`} title={v}>{v}</dd>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="h3d-section">
      <h3>{title}</h3>
      <dl className="h3d-grid">{children}</dl>
    </section>
  );
}

function Inspector({ node, level, visible, onSelectParent }: {
  node: HierarchyNode;
  level: number | null;
  visible: HierarchyRect | null;
  onSelectParent: (() => void) | undefined;
}) {
  const bg = node.backgroundColor;
  const name = shortClassName(node.class);
  const props = Object.entries(node.props);
  return (
    <div className="h3d-inspector-body">
      <header className="h3d-inspector-head">
        <div className="h3d-inspector-title">
          <KindIcon kind={nodeKind(node)} />
          <h2 title={node.class}>{name}</h2>
        </div>
        {name !== node.class && <div className="h3d-fullname h3d-mono">{node.class}</div>}
        {node.superclasses.length > 0 && (
          <div className="h3d-chain" title={[node.class, ...node.superclasses].join(" → ")}>
            {node.superclasses.map((c, i) => (
              <span key={i}>{i > 0 && <span className="h3d-chain-sep">›</span>}{shortClassName(c)}</span>
            ))}
          </div>
        )}
        {onSelectParent && <button type="button" className="h3d-btn h3d-btn-small" onClick={onSelectParent}>Select Superview</button>}
      </header>

      {node.snapshot && (
        <div className="h3d-snapshot">
          <img src={node.snapshot.url} alt={`${name} snapshot`} />
        </div>
      )}

      <Section title="Layout">
        <Row k="Frame (screen)" v={fmtRect(node.frame)} mono />
        {node.localFrame && <Row k="Frame" v={fmtRect(node.localFrame)} mono />}
        {node.bounds && <Row k="Bounds" v={fmtRect(node.bounds)} mono />}
        <Row k="Visible rect" v={visible ? fmtRect(visible) : "clipped"} mono={!!visible} />
        <Row k="Layer" v={level != null ? String(level) : "not drawn"} mono={level != null} />
        <Row k="Subview index" v={String(node.zIndex)} mono />
      </Section>

      <Section title="Appearance">
        <dt className="h3d-k">Background</dt>
        <dd className="h3d-v h3d-mono" title={fmtColor(bg)}>
          <span className="h3d-swatch" style={{ background: bg ? fmtColor(bg) : "transparent" }} />
          {fmtColorShort(bg)}
        </dd>
        <Row k="Alpha" v={fmt(node.alpha)} mono />
        <Row k="Hidden" v={node.hidden ? "Yes" : "No"} />
        <Row k="Clips to bounds" v={node.clipsToBounds ? "Yes" : "No"} />
        {node.layerClass && <Row k="Layer class" v={node.layerClass} />}
      </Section>

      {(node.viewController || node.accessibilityIdentifier || node.accessibilityLabel) && (
        <Section title="Identity">
          {node.viewController && <Row k="View controller" v={node.viewController} />}
          {node.accessibilityIdentifier && <Row k="Accessibility id" v={node.accessibilityIdentifier} />}
          {node.accessibilityLabel && <Row k="Accessibility label" v={node.accessibilityLabel} />}
        </Section>
      )}

      {props.length > 0 && (
        <Section title="Properties">
          {props.map(([k, v]) => <Row key={k} k={k} v={fmtProp(v)} mono={typeof v === "number" || Array.isArray(v)} />)}
        </Section>
      )}

      <Section title="Address">
        <Row k="id" v={node.id} mono />
      </Section>
    </div>
  );
}
