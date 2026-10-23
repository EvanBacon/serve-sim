import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ancestorIds, layoutHierarchy, type DepthMode, type Layout } from "../../hierarchy-3d/layout";
import type { HierarchyCaptureResponse, HierarchyNode, HierarchyPropValue, HierarchyRect } from "../../hierarchy-3d/model";
import { fitDistance, panTarget, type OrbitCamera } from "./projection";
import { HierarchyScene } from "./scene";

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

function nodeSummary(node: HierarchyNode): string {
  const p = node.props;
  const text = typeof p.text === "string" ? p.text : typeof p.title === "string" ? p.title : "";
  return node.accessibilityIdentifier || text || node.accessibilityLabel || "";
}

interface TreeRow {
  node: HierarchyNode;
  depth: number;
  hasChildren: boolean;
}

function flattenTree(windows: HierarchyNode[], collapsed: Set<string>, filter: string): TreeRow[] {
  const rows: TreeRow[] = [];
  const f = filter.trim().toLowerCase();
  if (f) {
    // Filtering shows matches flat, with their depth for indentation.
    const visit = (n: HierarchyNode, depth: number) => {
      const hay = `${n.class} ${n.accessibilityIdentifier ?? ""} ${n.accessibilityLabel ?? ""} ${nodeSummary(n)} ${n.viewController ?? ""}`.toLowerCase();
      if (hay.includes(f)) rows.push({ node: n, depth: 0, hasChildren: false });
      for (const c of n.children) visit(c, depth + 1);
    };
    for (const w of windows) visit(w, 0);
    return rows;
  }
  const visit = (n: HierarchyNode, depth: number) => {
    rows.push({ node: n, depth, hasChildren: n.children.length > 0 });
    if (collapsed.has(n.id)) return;
    for (const c of n.children) visit(c, depth + 1);
  };
  for (const w of windows) visit(w, 0);
  return rows;
}

function Disclosure({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined }}>
      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
  const [levelRange, setLevelRange] = useState<[number, number] | null>(null);
  const [orbiting, setOrbiting] = useState(params.orbit);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(-1);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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
  const rangeMin = levelRange ? Math.min(levelRange[0], maxLevel) : 0;
  const rangeMax = levelRange ? Math.min(levelRange[1], maxLevel) : maxLevel;
  const range: [number, number] = [rangeMin, rangeMax];
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
    () => ({ spacing, textures, outlines, minLevel: rangeMin, maxLevel: rangeMax, selected: selectedIndex, hovered, theme }),
    [spacing, textures, outlines, rangeMin, rangeMax, selectedIndex, hovered, theme],
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
      document.querySelector(`[data-node-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }, [selectedId, layout]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "r") void load();
      else if (e.key === "f") resetCamera();
      else if (e.key === "Escape") setSelectedId(null);
      else if (e.key === "ArrowUp" && selectedId && layout) {
        const idx = layout.indexById.get(selectedId);
        const parent = idx !== undefined ? layout.items[idx]!.parent : -1;
        if (parent >= 0) setSelectedId(layout.items[parent]!.node.id);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [load, resetCamera, selectedId, layout]);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const rows = useMemo(() => (capture ? flattenTree(capture.windows, collapsed, filter) : []), [capture, collapsed, filter]);

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
  const selectedItem = selectedIndex >= 0 ? layout?.items[selectedIndex] : undefined;

  return (
    <div className="h3d-root">
      <header className="h3d-toolbar">
        <div className="h3d-title">
          <strong>View Hierarchy</strong>
          <span className="h3d-badge">experimental</span>
          {capture && (
            <span className="h3d-sub">
              {capture.bundleId ?? "unknown app"} · {capture.nodeCount} views
              {capture.truncated ? " (truncated)" : ""} · {capture.source === "injected" ? "UIKit (injected)" : "accessibility fallback"}
              {capture.durationMs != null ? ` · ${Math.round(capture.durationMs)} ms` : ""}
            </span>
          )}
        </div>
        <div className="h3d-controls">
          <button type="button" onClick={() => void load()} disabled={loading} title="Refresh (R)">
            {loading ? "Capturing…" : "Refresh"}
          </button>
          <label className="h3d-slider" title="Spacing between layers">
            Spacing
            <input type="range" min={0} max={120} value={spacing} onInput={(e) => setSpacing(Number((e.target as HTMLInputElement).value))} />
          </label>
          <label className="h3d-slider" title="Lowest layer shown">
            Layers
            <input
              type="range" min={0} max={maxLevel} value={range[0]}
              onInput={(e) => { const v = Number((e.target as HTMLInputElement).value); setLevelRange([Math.min(v, range[1]), range[1]]); }}
            />
            <input
              type="range" min={0} max={maxLevel} value={range[1]}
              onInput={(e) => { const v = Number((e.target as HTMLInputElement).value); setLevelRange([range[0], Math.max(v, range[0])]); }}
            />
            <span className="h3d-mono">{range[0]}–{range[1]}</span>
          </label>
          <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as DepthMode)} title="How views are spread in depth">
            <option value="overlap">Depth: overlap</option>
            <option value="tree">Depth: tree</option>
          </select>
          <label><input type="checkbox" checked={textures} onChange={(e) => setTextures((e.target as HTMLInputElement).checked)} /> Snapshots</label>
          <label><input type="checkbox" checked={outlines} onChange={(e) => setOutlines((e.target as HTMLInputElement).checked)} /> Wireframes</label>
          <label title="Transparent container views don't take a layer"><input type="checkbox" checked={compact} onChange={(e) => setCompact((e.target as HTMLInputElement).checked)} /> Compact</label>
          <label><input type="checkbox" checked={clip} onChange={(e) => setClip((e.target as HTMLInputElement).checked)} /> Clip</label>
          <label><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden((e.target as HTMLInputElement).checked)} /> Hidden</label>
          <button type="button" onClick={() => setOrbiting((o) => !o)} aria-pressed={orbiting}>{orbiting ? "Stop orbit" : "Orbit"}</button>
          <button type="button" onClick={frontView}>Front</button>
          <button type="button" onClick={resetCamera} title="Reset camera (F / double-click)">Reset</button>
        </div>
      </header>

      {(response?.notice || error) && (
        <div className={`h3d-banner${error ? " h3d-banner-error" : ""}`}>
          <span>{error ?? response?.notice}</span>
          {response?.canInject && response.foreground && response.capture?.source !== "injected" && (
            <button type="button" onClick={() => void inject()} disabled={injecting}>
              {injecting ? "Relaunching…" : `Relaunch ${response.foreground.bundleId} with inspector`}
            </button>
          )}
        </div>
      )}

      <div className="h3d-main">
        <aside className="h3d-tree">
          <input className="h3d-filter" type="search" placeholder="Filter views" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          <TreeList
            rows={rows}
            selectedId={selectedId}
            collapsed={collapsed}
            layout={layout}
            onSelect={setSelectedId}
            onHover={setHovered}
            onToggle={toggleCollapsed}
          />
        </aside>

        <section className="h3d-viewport">
          <canvas ref={canvasRef} className="h3d-canvas" />
          {sceneError && <div className="h3d-overlay">{sceneError}</div>}
          {!capture && !sceneError && <div className="h3d-overlay">{loading ? "Capturing view hierarchy…" : error ?? "No hierarchy yet."}</div>}
          {hoveredNode && <div className="h3d-hover">{hoveredNode.class}{nodeSummary(hoveredNode) ? ` — ${nodeSummary(hoveredNode)}` : ""}</div>}
          {textures && textureProgress.total > 0 && textureProgress.loaded < textureProgress.total && (
            <div className="h3d-progress">Loading snapshots {textureProgress.loaded}/{textureProgress.total}</div>
          )}
          <div className="h3d-hint">Drag to orbit · Shift-drag to pan · Scroll to zoom · Click to select</div>
        </section>

        <aside className="h3d-inspector">
          {selectedNode ? (
            <Inspector node={selectedNode} level={selectedItem?.level ?? null} visible={selectedItem?.visibleRect ?? null} onSelectParent={
              selectedItem && selectedItem.parent >= 0 ? () => setSelectedId(layout!.items[selectedItem.parent]!.node.id) : undefined
            } />
          ) : (
            <div className="h3d-empty">Select a view in the 3D canvas or the tree.</div>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * Memoized so 3D hover / texture progress re-renders skip it; hovering a row
 * still highlights the view in 3D through `onHover`.
 */
const TreeList = memo(function TreeList({ rows, selectedId, collapsed, layout, onSelect, onHover, onToggle }: {
  rows: TreeRow[];
  selectedId: string | null;
  collapsed: Set<string>;
  layout: Layout | null;
  onSelect: (id: string) => void;
  onHover: (index: number) => void;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="h3d-rows" role="tree">
      {rows.map(({ node, depth, hasChildren }) => {
        const inLayout = layout?.indexById.has(node.id) ?? false;
        const isSel = node.id === selectedId;
        const summary = nodeSummary(node);
        return (
          <div
            key={node.id}
            data-node-id={node.id}
            role="treeitem"
            aria-selected={isSel}
            className={`h3d-row${isSel ? " is-selected" : ""}${inLayout ? "" : " is-hidden"}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={() => onSelect(node.id)}
            onMouseEnter={() => onHover(layout?.indexById.get(node.id) ?? -1)}
            onMouseLeave={() => onHover(-1)}
          >
            <span
              className="h3d-disclosure"
              onClick={(e) => {
                e.stopPropagation();
                if (hasChildren) onToggle(node.id);
              }}
            >
              {hasChildren ? <Disclosure open={!collapsed.has(node.id)} /> : null}
            </span>
            <span className="h3d-class">{node.class}</span>
            {summary && <span className="h3d-summary">{summary}</span>}
          </div>
        );
      })}
    </div>
  );
});

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="h3d-kv">
      <span className="h3d-k">{k}</span>
      <span className={`h3d-v${mono ? " h3d-mono" : ""}`}>{v}</span>
    </div>
  );
}

function Inspector({ node, level, visible, onSelectParent }: {
  node: HierarchyNode;
  level: number | null;
  visible: HierarchyRect | null;
  onSelectParent: (() => void) | undefined;
}) {
  const bg = node.backgroundColor;
  return (
    <div className="h3d-inspector-body">
      <h2 className="h3d-inspector-title">{node.class}</h2>
      {node.superclasses.length > 0 && <div className="h3d-chain">{node.superclasses.join(" → ")}</div>}
      {onSelectParent && <button type="button" className="h3d-link" onClick={onSelectParent}>Select superview ↑</button>}

      {node.snapshot && (
        <div className="h3d-snapshot">
          <img src={node.snapshot.url} alt={`${node.class} snapshot`} />
        </div>
      )}

      <h3>Layout</h3>
      <Row k="Frame (screen)" v={fmtRect(node.frame)} mono />
      {node.localFrame && <Row k="Frame" v={fmtRect(node.localFrame)} mono />}
      {node.bounds && <Row k="Bounds" v={fmtRect(node.bounds)} mono />}
      <Row k="Visible rect" v={visible ? fmtRect(visible) : "clipped"} mono />
      <Row k="Layer" v={level != null ? String(level) : "not drawn"} />
      <Row k="Subview index" v={String(node.zIndex)} />

      <h3>Appearance</h3>
      <div className="h3d-kv">
        <span className="h3d-k">Background</span>
        <span className="h3d-v">
          <span className="h3d-swatch" style={{ background: bg ? fmtColor(bg) : "transparent" }} />
          {fmtColor(bg)}
        </span>
      </div>
      <Row k="Alpha" v={fmt(node.alpha)} />
      <Row k="Hidden" v={node.hidden ? "yes" : "no"} />
      <Row k="Clips to bounds" v={node.clipsToBounds ? "yes" : "no"} />
      {node.layerClass && <Row k="Layer class" v={node.layerClass} />}

      {(node.viewController || node.accessibilityIdentifier || node.accessibilityLabel) && <h3>Identity</h3>}
      {node.viewController && <Row k="View controller" v={node.viewController} />}
      {node.accessibilityIdentifier && <Row k="Accessibility id" v={node.accessibilityIdentifier} />}
      {node.accessibilityLabel && <Row k="Accessibility label" v={node.accessibilityLabel} />}

      {Object.keys(node.props).length > 0 && <h3>Properties</h3>}
      {Object.entries(node.props).map(([k, v]) => <Row key={k} k={k} v={fmtProp(v)} />)}

      <h3>Address</h3>
      <Row k="id" v={node.id} mono />
    </div>
  );
}
