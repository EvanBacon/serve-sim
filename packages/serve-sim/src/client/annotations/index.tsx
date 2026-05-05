/**
 * Comment annotations UI — picker overlay + dropdown + toolbar buttons.
 *
 * Flow:
 *   1. User clicks the picker (grab) icon in the toolbar → `pickerActive` flips.
 *   2. PickerOverlay renders absolute over the simulator surface, intercepts
 *      pointer events. Hover highlights the smallest AX element under the
 *      cursor (Tier 3 + AX). Click freezes the bbox, captures a JPEG crop
 *      from the live MJPEG <img>, and shows the inline composer.
 *   3. User types a comment + Enter (or clicks ↑). We POST to the server's
 *      /api/annotations endpoint, which writes JSONL + crop to disk and
 *      returns the persisted Annotation. The annotations list refreshes,
 *      the badge counter ticks up, and picker stays active for the next pick.
 *   4. CommentsDropdown shows the accumulated list with delete-one /
 *      delete-all and a Copy button that builds a markdown bundle for the
 *      user to paste into Claude/Codex/Cursor.
 *
 * The picker uses AxSnapshotContext for hit-testing. If AX is unavailable
 * (axe CLI not installed), it falls back to plain coordinates (Tier 3 only).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { SimulatorToolbar } from "serve-sim-client/simulator";
import type {
  Annotation,
  AnnotationContext as AnnotationContextMeta,
  AnnotationCreateRequest,
  AnnotationDevice,
  AnnotationPoint,
  AnnotationRegion,
} from "../../annotations-shared";
import type { AxElement, AxSnapshot } from "../../ax-shared";

// ─── API client ───

function apiBase(basePath: string): string {
  return basePath === "/" ? "" : basePath.replace(/\/+$/, "");
}

function endpointFor(basePath: string, suffix: string, device?: string): string {
  const url = `${apiBase(basePath)}/api/annotations${suffix}`;
  return device ? `${url}?device=${encodeURIComponent(device)}` : url;
}

async function fetchAnnotations(basePath: string, device: string): Promise<Annotation[]> {
  try {
    const res = await fetch(endpointFor(basePath, "", device));
    if (!res.ok) return [];
    return (await res.json()) as Annotation[];
  } catch {
    return [];
  }
}

async function postAnnotation(
  basePath: string,
  device: string,
  req: AnnotationCreateRequest,
): Promise<Annotation | null> {
  try {
    const res = await fetch(endpointFor(basePath, "", device), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) return null;
    return (await res.json()) as Annotation;
  } catch {
    return null;
  }
}

async function deleteAnnotationApi(
  basePath: string,
  device: string,
  id: string,
): Promise<boolean> {
  try {
    const res = await fetch(endpointFor(basePath, `/${id}`, device), { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteAllAnnotationsApi(basePath: string, device: string): Promise<boolean> {
  try {
    const res = await fetch(endpointFor(basePath, "", device), { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Context ───

interface AnnotationsContextValue {
  annotations: Annotation[];
  pickerActive: boolean;
  setPickerActive: (value: boolean) => void;
  dropdownOpen: boolean;
  setDropdownOpen: (value: boolean) => void;
  refresh: () => void;
  create: (req: Omit<AnnotationCreateRequest, "device">) => Promise<Annotation | null>;
  remove: (id: string) => Promise<void>;
  removeAll: () => Promise<void>;
  /** AX key (axElementKey output) to flash a bbox highlight in the picker overlay. */
  flashKey: string | null;
  setFlashKey: (key: string | null) => void;
  basePath: string;
  device: AnnotationDevice | null;
  /** DOM anchor for the Comments dropdown — set by the toolbar button. */
  commentsAnchor: HTMLElement | null;
  setCommentsAnchor: (el: HTMLElement | null) => void;
}

const AnnotationsContext = createContext<AnnotationsContextValue | null>(null);

export function useAnnotations(): AnnotationsContextValue {
  const ctx = useContext(AnnotationsContext);
  if (!ctx) throw new Error("useAnnotations: missing <AnnotationsProvider>");
  return ctx;
}

export function AnnotationsProvider({
  basePath,
  device,
  pickerActive,
  onPickerActiveChange,
  dropdownOpen,
  onDropdownOpenChange,
  children,
}: {
  basePath: string;
  device: AnnotationDevice | null;
  /** Lifted up so the parent can also drive the AX endpoint subscription. */
  pickerActive: boolean;
  onPickerActiveChange: (value: boolean) => void;
  dropdownOpen: boolean;
  onDropdownOpenChange: (value: boolean) => void;
  children: ReactNode;
}) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [commentsAnchor, setCommentsAnchor] = useState<HTMLElement | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (!device?.udid) {
      setAnnotations([]);
      return;
    }
    void fetchAnnotations(basePath, device.udid).then(setAnnotations);
  }, [basePath, device?.udid]);

  // Initial load + reload when device changes.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Reset state when the active device changes — annotations are device-scoped.
  const lastUdidRef = useRef(device?.udid ?? null);
  useEffect(() => {
    if (lastUdidRef.current !== (device?.udid ?? null)) {
      onPickerActiveChange(false);
      onDropdownOpenChange(false);
      lastUdidRef.current = device?.udid ?? null;
    }
  }, [device?.udid, onPickerActiveChange, onDropdownOpenChange]);

  const setPickerActive = useCallback((value: boolean) => {
    onPickerActiveChange(value);
    if (!value) setFlashKey(null);
  }, [onPickerActiveChange]);

  const setDropdownOpen = useCallback((value: boolean) => {
    onDropdownOpenChange(value);
  }, [onDropdownOpenChange]);

  const setFlashKeyTimed = useCallback((key: string | null) => {
    setFlashKey(key);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (key) {
      flashTimerRef.current = setTimeout(() => setFlashKey(null), 1200);
    }
  }, []);

  const create = useCallback(
    async (req: Omit<AnnotationCreateRequest, "device">): Promise<Annotation | null> => {
      if (!device?.udid) return null;
      const created = await postAnnotation(basePath, device.udid, { ...req, device });
      if (created) setAnnotations((prev) => [...prev, created]);
      return created;
    },
    [basePath, device],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!device?.udid) return;
      const ok = await deleteAnnotationApi(basePath, device.udid, id);
      if (ok) setAnnotations((prev) => prev.filter((a) => a.id !== id));
    },
    [basePath, device?.udid],
  );

  const removeAll = useCallback(async () => {
    if (!device?.udid) return;
    const ok = await deleteAllAnnotationsApi(basePath, device.udid);
    if (ok) setAnnotations([]);
  }, [basePath, device?.udid]);

  const value = useMemo<AnnotationsContextValue>(
    () => ({
      annotations,
      pickerActive,
      setPickerActive,
      dropdownOpen,
      setDropdownOpen,
      refresh,
      create,
      remove,
      removeAll,
      flashKey,
      setFlashKey: setFlashKeyTimed,
      basePath,
      device,
      commentsAnchor,
      setCommentsAnchor,
    }),
    [
      annotations,
      pickerActive,
      setPickerActive,
      dropdownOpen,
      setDropdownOpen,
      refresh,
      create,
      remove,
      removeAll,
      flashKey,
      setFlashKeyTimed,
      basePath,
      device,
      commentsAnchor,
    ],
  );

  return <AnnotationsContext.Provider value={value}>{children}</AnnotationsContext.Provider>;
}

// ─── AX hit-testing ───

function axElementContainsPoint(el: AxElement, x: number, y: number): boolean {
  return (
    x >= el.frame.x &&
    x <= el.frame.x + el.frame.width &&
    y >= el.frame.y &&
    y <= el.frame.y + el.frame.height
  );
}

function pickAxElement(snapshot: AxSnapshot | null, xScreen: number, yScreen: number): AxElement | null {
  if (!snapshot || snapshot.elements.length === 0) return null;
  let best: AxElement | null = null;
  let bestArea = Infinity;
  for (const el of snapshot.elements) {
    if (!axElementContainsPoint(el, xScreen, yScreen)) continue;
    const area = Math.max(1, el.frame.width) * Math.max(1, el.frame.height);
    if (area < bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

function axElementKey(el: AxElement): string {
  return el.id;
}

function axElementLabel(el: AxElement): string {
  return el.label || el.role || el.type || "element";
}

function axElementContext(el: AxElement): AnnotationContextMeta {
  const ctx: AnnotationContextMeta = {};
  if (el.label) ctx.accessibilityLabel = el.label;
  if (el.role) ctx.accessibilityRole = el.role;
  if (el.type) ctx.accessibilityType = el.type;
  if (el.id) ctx.accessibilityId = el.id;
  return ctx;
}

// ─── Crop capture ───

const CROP_MAX_DIMENSION = 256;
const CROP_DEFAULT_RADIUS = 96; // half-width when no AX bbox is available
const CROP_QUALITY = 0.7;

function findStreamImage(container: HTMLElement | null): HTMLImageElement | null {
  if (!container) return null;
  const imgs = container.querySelectorAll("img");
  for (const img of imgs) {
    if (!(img instanceof HTMLImageElement)) continue;
    if (img.style.display === "none") continue;
    if (img.naturalWidth === 0 || img.naturalHeight === 0) continue;
    return img;
  }
  return null;
}

interface CropResult {
  cropDataUri: string;
  /** Region cropped, in physical pixel coords on the source image. */
  pixelRegion: { x: number; y: number; w: number; h: number };
}

function captureCrop(
  img: HTMLImageElement,
  pixelRegion: { x: number; y: number; w: number; h: number },
): CropResult | null {
  const sx = Math.max(0, Math.floor(pixelRegion.x));
  const sy = Math.max(0, Math.floor(pixelRegion.y));
  const sw = Math.min(img.naturalWidth - sx, Math.ceil(pixelRegion.w));
  const sh = Math.min(img.naturalHeight - sy, Math.ceil(pixelRegion.h));
  if (sw <= 0 || sh <= 0) return null;

  const longest = Math.max(sw, sh);
  const scale = longest > CROP_MAX_DIMENSION ? CROP_MAX_DIMENSION / longest : 1;
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  } catch {
    return null;
  }
  let cropDataUri: string;
  try {
    cropDataUri = canvas.toDataURL("image/jpeg", CROP_QUALITY);
  } catch {
    return null;
  }
  return { cropDataUri, pixelRegion: { x: sx, y: sy, w: sw, h: sh } };
}

// ─── Toolbar icons ───

const PickerIcon = (
  // Crosshair + arrow — same visual language as react-grab's grab cursor.
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2v4" />
    <path d="M12 18v4" />
    <path d="M2 12h4" />
    <path d="M18 12h4" />
    <circle cx="12" cy="12" r="3.2" />
  </svg>
);

const CommentsIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const TrashIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);

const SubmitIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5" />
    <path d="M5 12l7-7 7 7" />
  </svg>
);

// ─── Toolbar buttons ───

export function AnnotationsToolbarButtons() {
  const {
    pickerActive,
    setPickerActive,
    dropdownOpen,
    setDropdownOpen,
    annotations,
    setCommentsAnchor,
  } = useAnnotations();
  const pendingCount = annotations.length;
  const commentsRef = useCallback(
    (el: HTMLButtonElement | null) => {
      setCommentsAnchor(el);
    },
    [setCommentsAnchor],
  );

  return (
    <>
      <SimulatorToolbar.Button
        aria-label={pickerActive ? "Exit comment picker" : "Enter comment picker"}
        aria-pressed={pickerActive}
        title={pickerActive ? "Exit picker (Esc)" : "Pick element to comment"}
        onClick={() => setPickerActive(!pickerActive)}
        style={pickerActive ? { ...activeButtonStyle } : undefined}
      >
        {PickerIcon}
      </SimulatorToolbar.Button>
      <SimulatorToolbar.Button
        ref={commentsRef}
        aria-label={dropdownOpen ? "Close comments" : "Open comments"}
        aria-pressed={dropdownOpen}
        title={
          pendingCount === 0
            ? "Comments (none yet)"
            : `Comments (${pendingCount})`
        }
        onClick={() => setDropdownOpen(!dropdownOpen)}
        style={
          dropdownOpen
            ? { ...activeButtonStyle, position: "relative" }
            : { position: "relative" }
        }
      >
        {CommentsIcon}
        {pendingCount > 0 && <span style={badgeStyle}>{pendingCount}</span>}
      </SimulatorToolbar.Button>
    </>
  );
}

// ─── Tools panel section ───

export function AnnotationsTool({
  enabled,
  onToggleEnabled,
  axeUnavailable,
}: {
  enabled: boolean;
  onToggleEnabled: () => void;
  axeUnavailable: boolean;
}) {
  const { annotations } = useAnnotations();
  return (
    <section style={toolSection}>
      <div style={toolHeader}>
        <span style={toolTitle}>Comments</span>
        <button
          type="button"
          onClick={onToggleEnabled}
          aria-pressed={enabled}
          style={enabled ? toolToggleActive : toolToggle}
        >
          {enabled ? "Enabled" : "Enable"}
        </button>
      </div>
      {!enabled && (
        <div style={toolBody}>
          Pick elements on the simulator and attach comments. Export as a markdown
          bundle for Claude Code, Cursor or Codex.
        </div>
      )}
      {enabled && axeUnavailable && (
        <div style={toolWarn}>
          <strong>AX unavailable</strong> — install{" "}
          <a
            href="https://github.com/cameroncooke/AXe"
            target="_blank"
            rel="noreferrer"
            style={toolLink}
          >
            AXe
          </a>{" "}
          to highlight real elements while picking.
          <br />
          <code style={toolCode}>brew install cameroncooke/axe/axe</code>
        </div>
      )}
      {enabled && !axeUnavailable && annotations.length === 0 && (
        <div style={toolBody}>
          Use the picker icon in the toolbar — tap an element to add a comment.
        </div>
      )}
      {enabled && annotations.length > 0 && (
        <div style={toolBody}>
          {annotations.length} pending — open the comments dropdown to copy the
          markdown bundle.
        </div>
      )}
    </section>
  );
}

const toolSection: CSSProperties = {
  background: "#1c1c1e",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 10,
  padding: "8px 12px",
};
const toolHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};
const toolTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "rgba(255,255,255,0.5)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};
const toolToggle: CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "rgba(255,255,255,0.85)",
  fontSize: 11,
  padding: "3px 10px",
  borderRadius: 6,
  cursor: "pointer",
  fontFamily: "inherit",
};
const toolToggleActive: CSSProperties = {
  ...toolToggle,
  background: "rgba(96,165,250,0.18)",
  borderColor: "rgba(96,165,250,0.5)",
  color: "#bfdbfe",
};
const toolBody: CSSProperties = {
  fontSize: 12,
  color: "rgba(226,232,240,0.7)",
  lineHeight: 1.45,
  marginTop: 8,
};
const toolWarn: CSSProperties = {
  fontSize: 12,
  color: "#fbbf24",
  background: "rgba(251,191,36,0.08)",
  border: "1px solid rgba(251,191,36,0.25)",
  borderRadius: 8,
  padding: "8px 10px",
  lineHeight: 1.5,
  marginTop: 8,
};
const toolLink: CSSProperties = {
  color: "#fbbf24",
  textDecoration: "underline",
};
const toolCode: CSSProperties = {
  display: "inline-block",
  marginTop: 4,
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
  background: "rgba(0,0,0,0.35)",
  padding: "2px 6px",
  borderRadius: 4,
  color: "#fde68a",
};

// ─── Picker overlay ───

interface PickerComposerState {
  point: AnnotationPoint;
  region?: AnnotationRegion;
  axElement: AxElement | null;
  cropDataUri: string;
  /** Anchor for the composer popover, in overlay-normalized 0..1 coords. */
  anchor: { x: number; y: number };
}

export function AnnotationsPickerOverlay({
  snapshot,
  containerRef,
}: {
  snapshot: AxSnapshot | null;
  /** Ref to the relative-positioned simulator container that holds <SimulatorView>. */
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const {
    pickerActive,
    setPickerActive,
    create,
    annotations,
    flashKey,
  } = useAnnotations();

  const [hover, setHover] = useState<{
    el: AxElement | null;
    xNorm: number;
    yNorm: number;
  } | null>(null);
  const [composer, setComposer] = useState<PickerComposerState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [comment, setComment] = useState("");
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset all transient state when picker turns off.
  useEffect(() => {
    if (!pickerActive) {
      setHover(null);
      setComposer(null);
      setComment("");
    }
  }, [pickerActive]);

  // Focus the composer input when it opens.
  useEffect(() => {
    if (composer && inputRef.current) {
      inputRef.current.focus();
    }
  }, [composer]);

  // ESC exits picker mode (also closes composer if open).
  useEffect(() => {
    if (!pickerActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (composer) {
          setComposer(null);
          setComment("");
        } else {
          setPickerActive(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerActive, composer, setPickerActive]);


  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (composer) return; // freeze hover while composing
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect) return;
      const xNorm = (e.clientX - rect.left) / rect.width;
      const yNorm = (e.clientY - rect.top) / rect.height;
      let el: AxElement | null = null;
      if (snapshot && snapshot.screen.width > 1 && snapshot.screen.height > 1) {
        const xScreen = xNorm * snapshot.screen.width;
        const yScreen = yNorm * snapshot.screen.height;
        el = pickAxElement(snapshot, xScreen, yScreen);
      }
      setHover({ el, xNorm, yNorm });
    },
    [snapshot, composer],
  );

  const handleMouseLeave = useCallback(() => {
    if (composer) return;
    setHover(null);
  }, [composer]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = overlayRef.current?.getBoundingClientRect();
      const container = containerRef.current;
      if (!rect || !container) return;
      const img = findStreamImage(container);
      if (!img) return;
      const xNorm = (e.clientX - rect.left) / rect.width;
      const yNorm = (e.clientY - rect.top) / rect.height;

      let el: AxElement | null = null;
      let pointSim: AnnotationPoint;
      let region: AnnotationRegion | undefined;
      let pixelRegion: { x: number; y: number; w: number; h: number };

      if (snapshot && snapshot.screen.width > 1 && snapshot.screen.height > 1) {
        const xScreen = xNorm * snapshot.screen.width;
        const yScreen = yNorm * snapshot.screen.height;
        pointSim = { x: Math.round(xScreen), y: Math.round(yScreen) };
        el = pickAxElement(snapshot, xScreen, yScreen);
        const scaleX = img.naturalWidth / snapshot.screen.width;
        const scaleY = img.naturalHeight / snapshot.screen.height;
        if (el) {
          region = {
            x: el.frame.x,
            y: el.frame.y,
            w: el.frame.width,
            h: el.frame.height,
          };
          pixelRegion = {
            x: el.frame.x * scaleX,
            y: el.frame.y * scaleY,
            w: el.frame.width * scaleX,
            h: el.frame.height * scaleY,
          };
        } else {
          // No bbox — crop a square around the click point.
          pixelRegion = {
            x: xNorm * img.naturalWidth - CROP_DEFAULT_RADIUS,
            y: yNorm * img.naturalHeight - CROP_DEFAULT_RADIUS,
            w: CROP_DEFAULT_RADIUS * 2,
            h: CROP_DEFAULT_RADIUS * 2,
          };
        }
      } else {
        // No AX snapshot at all (Tier 3 plain).
        pointSim = {
          x: Math.round(xNorm * img.naturalWidth),
          y: Math.round(yNorm * img.naturalHeight),
        };
        pixelRegion = {
          x: xNorm * img.naturalWidth - CROP_DEFAULT_RADIUS,
          y: yNorm * img.naturalHeight - CROP_DEFAULT_RADIUS,
          w: CROP_DEFAULT_RADIUS * 2,
          h: CROP_DEFAULT_RADIUS * 2,
        };
      }

      const cropped = captureCrop(img, pixelRegion);
      if (!cropped) return;

      // Shift+click = quick-add with empty comment.
      if (e.shiftKey) {
        void create({
          point: pointSim,
          region,
          context: el ? axElementContext(el) : undefined,
          comment: "",
          cropDataUri: cropped.cropDataUri,
        });
        return;
      }

      setComposer({
        point: pointSim,
        region,
        axElement: el,
        cropDataUri: cropped.cropDataUri,
        anchor: { x: xNorm, y: yNorm },
      });
      setComment("");
    },
    [snapshot, create, containerRef],
  );

  const submitComposer = useCallback(async () => {
    if (!composer || submitting) return;
    setSubmitting(true);
    try {
      const created = await create({
        point: composer.point,
        region: composer.region,
        context: composer.axElement ? axElementContext(composer.axElement) : undefined,
        comment: comment.trim(),
        cropDataUri: composer.cropDataUri,
      });
      if (created) {
        setComposer(null);
        setComment("");
      }
    } finally {
      setSubmitting(false);
    }
  }, [composer, comment, create, submitting]);

  // Show flashing bbox for "click an item in dropdown to locate it" — driven by
  // flashKey from context.
  const flashRect = useMemo(() => {
    if (!flashKey || !snapshot) return null;
    const matchingAnno = annotations.find(
      (a) => a.context?.accessibilityId === flashKey || a.id === flashKey,
    );
    if (matchingAnno?.region) {
      return {
        x: matchingAnno.region.x / snapshot.screen.width,
        y: matchingAnno.region.y / snapshot.screen.height,
        w: matchingAnno.region.w / snapshot.screen.width,
        h: matchingAnno.region.h / snapshot.screen.height,
      };
    }
    return null;
  }, [flashKey, snapshot, annotations]);

  if (!pickerActive && !flashRect) return null;

  const screen = snapshot?.screen;
  const axBbox =
    composer?.axElement?.frame ??
    (hover && !composer ? hover.el?.frame : null) ??
    null;
  const showAxBbox = axBbox && screen && screen.width > 1 && screen.height > 1;
  const composerAxElement = composer?.axElement ?? null;

  return (
    <div
      ref={overlayRef}
      onMouseMove={pickerActive ? handleMouseMove : undefined}
      onMouseLeave={pickerActive ? handleMouseLeave : undefined}
      onClick={pickerActive ? handleClick : undefined}
      style={{
        ...overlayStyle,
        cursor: pickerActive ? "crosshair" : "default",
        pointerEvents: pickerActive ? "auto" : "none",
        background: pickerActive ? "rgba(99,102,241,0.04)" : "transparent",
      }}
    >
      {showAxBbox && screen && axBbox && (
        <div
          aria-hidden="true"
          style={{
            ...bboxStyle,
            left: `${(axBbox.x / screen.width) * 100}%`,
            top: `${(axBbox.y / screen.height) * 100}%`,
            width: `${(axBbox.width / screen.width) * 100}%`,
            height: `${(axBbox.height / screen.height) * 100}%`,
            borderColor: composer ? "#c084fc" : "#a78bfa",
            background: composer ? "rgba(192,132,252,0.18)" : "rgba(167,139,250,0.14)",
          }}
        />
      )}

      {flashRect && screen && (
        <div
          aria-hidden="true"
          style={{
            ...bboxStyle,
            left: `${flashRect.x * 100}%`,
            top: `${flashRect.y * 100}%`,
            width: `${flashRect.w * 100}%`,
            height: `${flashRect.h * 100}%`,
            borderColor: "#fbbf24",
            background: "rgba(251,191,36,0.18)",
            animation: "annotations-flash 1.2s ease-in-out",
          }}
        />
      )}

      {pickerActive && hover && !composer && hover.el && (
        <PickerHoverBadge
          xNorm={hover.xNorm}
          yNorm={hover.yNorm}
          element={hover.el}
        />
      )}

      {pickerActive && composer && (
        <PickerComposer
          xNorm={composer.anchor.x}
          yNorm={composer.anchor.y}
          element={composerAxElement}
          comment={comment}
          submitting={submitting}
          onChange={setComment}
          onSubmit={submitComposer}
          onCancel={() => {
            setComposer(null);
            setComment("");
          }}
          inputRef={inputRef}
        />
      )}
    </div>
  );
}

function PickerHoverBadge({
  xNorm,
  yNorm,
  element,
}: {
  xNorm: number;
  yNorm: number;
  element: AxElement | null;
}) {
  const label = element ? axElementLabel(element) : "pick a point";
  return (
    <div style={floatBadgeStyle(xNorm, yNorm)}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {element?.role && element.role !== element.label && (
        <span style={{ opacity: 0.7, marginLeft: 6 }}>{element.role}</span>
      )}
    </div>
  );
}

function PickerComposer({
  xNorm,
  yNorm,
  element,
  comment,
  submitting,
  onChange,
  onSubmit,
  onCancel,
  inputRef,
}: {
  xNorm: number;
  yNorm: number;
  element: AxElement | null;
  comment: string;
  submitting: boolean;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
}) {
  const label = element ? axElementLabel(element) : "Annotation";
  return (
    <div style={composerStyle(xNorm, yNorm)} onClick={(e) => e.stopPropagation()}>
      <div style={composerLabelStyle}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {element?.role && element.role !== element.label && (
          <span style={{ opacity: 0.7, marginLeft: 6, fontSize: 11 }}>{element.role}</span>
        )}
      </div>
      <div style={composerInputRow}>
        <input
          ref={inputRef}
          type="text"
          placeholder="Add context"
          value={comment}
          onChange={(e) => onChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          disabled={submitting}
          style={composerInputStyle}
        />
        <button
          type="button"
          aria-label="Submit comment"
          title="Submit (Enter)"
          onClick={onSubmit}
          disabled={submitting}
          style={composerSubmitStyle}
        >
          {SubmitIcon}
        </button>
      </div>
    </div>
  );
}

// ─── Comments dropdown ───

export function AnnotationsDropdown() {
  const {
    annotations,
    dropdownOpen,
    setDropdownOpen,
    remove,
    removeAll,
    setFlashKey,
    basePath,
    commentsAnchor: anchor,
  } = useAnnotations();
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  // Anchor positioning — recompute on open + on resize.
  useEffect(() => {
    if (!dropdownOpen || !anchor) return;
    const compute = () => {
      const rect = anchor.getBoundingClientRect();
      setPosition({
        top: rect.bottom + 8,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [dropdownOpen, anchor]);

  // Click-outside + ESC.
  useEffect(() => {
    if (!dropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDropdownOpen(false);
      if ((e.key === "c" || e.key === "C") && (e.metaKey || e.ctrlKey)) {
        const target = e.target as HTMLElement | null;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
        e.preventDefault();
        void copyBundleToClipboard(annotations, basePath, () => setCopyState("copied"));
        setTimeout(() => setCopyState("idle"), 1200);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [dropdownOpen, anchor, setDropdownOpen, annotations, basePath]);

  const handleCopy = useCallback(async () => {
    await copyBundleToClipboard(annotations, basePath, () => setCopyState("copied"));
    setTimeout(() => setCopyState("idle"), 1200);
  }, [annotations, basePath]);

  const handleClearAll = useCallback(async () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      setTimeout(() => setConfirmingClear(false), 2500);
      return;
    }
    await removeAll();
    setConfirmingClear(false);
  }, [confirmingClear, removeAll]);

  if (!dropdownOpen) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Comments"
      style={{
        ...dropdownStyle,
        top: position?.top ?? 96,
        right: position?.right ?? 24,
      }}
    >
      <div style={dropdownHeaderStyle}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          Comments
          {annotations.length > 0 && (
            <span style={{ opacity: 0.5, marginLeft: 6 }}>{annotations.length}</span>
          )}
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            type="button"
            onClick={handleCopy}
            disabled={annotations.length === 0}
            style={dropdownCopyStyle(annotations.length === 0)}
            title="Copy markdown bundle to clipboard (Cmd/Ctrl+C)"
          >
            {copyState === "copied" ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={handleClearAll}
            disabled={annotations.length === 0}
            style={dropdownTrashStyle(confirmingClear, annotations.length === 0)}
            aria-label={confirmingClear ? "Confirm clear all" : "Clear all comments"}
            title={confirmingClear ? "Click again to confirm" : "Clear all"}
          >
            {TrashIcon}
          </button>
        </div>
      </div>
      {annotations.length === 0 ? (
        <div style={dropdownEmptyStyle}>
          No comments yet. Click the picker icon and select an element.
        </div>
      ) : (
        <div style={dropdownListStyle} role="list">
          {annotations.map((anno) => (
            <DropdownItem
              key={anno.id}
              annotation={anno}
              onDelete={() => remove(anno.id)}
              onLocate={() => setFlashKey(anno.context?.accessibilityId ?? anno.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DropdownItem({
  annotation,
  onDelete,
  onLocate,
}: {
  annotation: Annotation;
  onDelete: () => void;
  onLocate: () => void;
}) {
  const [hover, setHover] = useState(false);
  const tag =
    annotation.context?.accessibilityRole ||
    annotation.context?.accessibilityType ||
    annotation.context?.componentName ||
    "element";
  const label = annotation.context?.accessibilityLabel || annotation.context?.componentName;
  const relative = formatRelativeTime(annotation.createdAt);

  return (
    <div
      role="listitem"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onLocate}
      style={{
        ...dropdownItemStyle,
        background: hover ? "rgba(255,255,255,0.06)" : "transparent",
      }}
    >
      <div style={dropdownItemHeaderStyle}>
        <span style={dropdownItemTagStyle}>{tag}</span>
        {label && <span style={dropdownItemLabelStyle}>{label}</span>}
        <span style={dropdownItemTimeStyle}>{relative}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{
            ...dropdownItemDeleteStyle,
            opacity: hover ? 1 : 0,
            pointerEvents: hover ? "auto" : "none",
          }}
          aria-label="Delete this comment"
          title="Delete"
        >
          {TrashIcon}
        </button>
      </div>
      {annotation.comment && (
        <div style={dropdownItemCommentStyle}>{annotation.comment}</div>
      )}
    </div>
  );
}

// ─── Markdown export ───

function buildMarkdownBundle(
  annotations: Annotation[],
  basePath: string,
  origin: string,
): string {
  const head = annotations[0];
  const lines: string[] = [];
  lines.push(`# Feedback from simulator session`);
  if (head) {
    lines.push(`Device: ${head.device.name || head.device.udid} (UDID: ${head.device.udid})`);
  }
  const now = new Date().toISOString();
  lines.push(`Captured: ${annotations.length} annotation${annotations.length === 1 ? "" : "s"} · ${now}`);
  lines.push("");
  annotations.forEach((anno, index) => {
    const num = index + 1;
    const heading = anno.comment.trim() || "(no comment)";
    lines.push(`## [${num}] ${heading}`);
    const ctx = anno.context;
    if (ctx?.componentName) {
      const file = ctx.sourceFile
        ? ctx.sourceLine
          ? `${ctx.sourceFile}:${ctx.sourceLine}`
          : ctx.sourceFile
        : "";
      lines.push(`- Component: ${ctx.componentName}${file ? ` (${file})` : ""}`);
    } else if (ctx?.accessibilityLabel || ctx?.accessibilityRole) {
      const role = ctx.accessibilityRole || ctx.accessibilityType || "element";
      const label = ctx.accessibilityLabel ? `"${ctx.accessibilityLabel}"` : "";
      lines.push(`- Element: ${role}${label ? ` ${label}` : ""}`);
    }
    lines.push(`- Location: (${Math.round(anno.point.x)}, ${Math.round(anno.point.y)})`);
    const cropUrl = `${origin}${apiBase(basePath)}/api/annotations/${anno.id}/crop?device=${encodeURIComponent(anno.device.udid)}`;
    lines.push(`- Screenshot: ${cropUrl}`);
    lines.push("");
  });
  return lines.join("\n");
}

async function copyBundleToClipboard(
  annotations: Annotation[],
  basePath: string,
  onSuccess: () => void,
): Promise<void> {
  if (annotations.length === 0) return;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const md = buildMarkdownBundle(annotations, basePath, origin);
  try {
    await navigator.clipboard.writeText(md);
    onSuccess();
  } catch {
    // Fallback for non-secure contexts.
    const textarea = document.createElement("textarea");
    textarea.value = md;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try { document.execCommand("copy"); onSuccess(); } catch {}
    document.body.removeChild(textarea);
  }
}

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ─── Styles ───

const activeButtonStyle: CSSProperties = {
  background: "rgba(96,165,250,0.18)",
  color: "#bfdbfe",
};

const badgeStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  minWidth: 14,
  height: 14,
  padding: "0 4px",
  borderRadius: 7,
  background: "#60a5fa",
  color: "#0a0a0a",
  fontSize: 9,
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};

const overlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 40,
  userSelect: "none",
};

const bboxStyle: CSSProperties = {
  position: "absolute",
  borderWidth: 1.5,
  borderStyle: "solid",
  borderRadius: 6,
  pointerEvents: "none",
  transition: "left 80ms ease, top 80ms ease, width 80ms ease, height 80ms ease",
};

function floatBadgeStyle(xNorm: number, yNorm: number): CSSProperties {
  return {
    position: "absolute",
    left: `${xNorm * 100}%`,
    top: `${yNorm * 100}%`,
    transform: "translate(12px, 12px)",
    background: "rgba(15,23,42,0.92)",
    color: "#e2e8f0",
    fontSize: 11,
    fontFamily: "-apple-system, system-ui, sans-serif",
    padding: "4px 8px",
    borderRadius: 6,
    border: "1px solid rgba(148,163,184,0.3)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
    boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
    pointerEvents: "none",
    whiteSpace: "nowrap",
  };
}

function composerStyle(xNorm: number, yNorm: number): CSSProperties {
  // Anchor below the click; clamp to stay inside the surface via translate
  // bias when near edges. Keep simple here — the surface clips anything
  // truly off-screen.
  const below = yNorm < 0.7;
  return {
    position: "absolute",
    left: `${xNorm * 100}%`,
    top: `${yNorm * 100}%`,
    transform: below ? "translate(8px, 8px)" : "translate(8px, calc(-100% - 8px))",
    minWidth: 220,
    maxWidth: 320,
    padding: "8px 10px",
    background: "rgba(17,24,39,0.96)",
    border: "1px solid rgba(148,163,184,0.35)",
    borderRadius: 10,
    boxShadow: "0 10px 32px rgba(0,0,0,0.5)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    color: "#f8fafc",
    fontFamily: "-apple-system, system-ui, sans-serif",
    pointerEvents: "auto",
    zIndex: 41,
  };
}

const composerLabelStyle: CSSProperties = {
  fontSize: 11,
  marginBottom: 6,
  color: "#cbd5e1",
};

const composerInputRow: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
};

const composerInputStyle: CSSProperties = {
  flex: 1,
  fontSize: 13,
  padding: "5px 8px",
  background: "rgba(15,23,42,0.85)",
  color: "#f8fafc",
  border: "1px solid rgba(148,163,184,0.4)",
  borderRadius: 6,
  outline: "none",
  fontFamily: "inherit",
};

const composerSubmitStyle: CSSProperties = {
  background: "rgba(96,165,250,0.18)",
  border: "1px solid rgba(96,165,250,0.4)",
  color: "#bfdbfe",
  width: 26,
  height: 26,
  borderRadius: 6,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const dropdownStyle: CSSProperties = {
  position: "fixed",
  width: 320,
  maxWidth: "calc(100vw - 24px)",
  maxHeight: "70vh",
  background: "rgba(17,24,39,0.96)",
  border: "1px solid rgba(148,163,184,0.25)",
  borderRadius: 12,
  boxShadow: "0 18px 48px rgba(0,0,0,0.55)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  color: "#f8fafc",
  fontFamily: "-apple-system, system-ui, sans-serif",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  zIndex: 100,
};

const dropdownHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 12px",
  borderBottom: "1px solid rgba(148,163,184,0.12)",
};

function dropdownCopyStyle(disabled: boolean): CSSProperties {
  return {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    color: disabled ? "rgba(255,255,255,0.3)" : "#e2e8f0",
    padding: "3px 10px",
    fontSize: 11,
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
  };
}

function dropdownTrashStyle(confirming: boolean, disabled: boolean): CSSProperties {
  return {
    background: confirming ? "rgba(248,113,113,0.18)" : "transparent",
    border: confirming ? "1px solid rgba(248,113,113,0.5)" : "1px solid transparent",
    color: disabled ? "rgba(255,255,255,0.25)" : confirming ? "#fecaca" : "#f87171",
    padding: 4,
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

const dropdownEmptyStyle: CSSProperties = {
  padding: "20px 16px",
  fontSize: 12,
  color: "rgba(226,232,240,0.55)",
  textAlign: "center",
  lineHeight: 1.45,
};

const dropdownListStyle: CSSProperties = {
  overflowY: "auto",
  maxHeight: "60vh",
};

const dropdownItemStyle: CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid rgba(148,163,184,0.08)",
  cursor: "pointer",
  transition: "background 120ms ease",
};

const dropdownItemHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  marginBottom: 2,
};

const dropdownItemTagStyle: CSSProperties = {
  fontWeight: 600,
  color: "#bfdbfe",
};

const dropdownItemLabelStyle: CSSProperties = {
  color: "rgba(226,232,240,0.7)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
};

const dropdownItemTimeStyle: CSSProperties = {
  color: "rgba(226,232,240,0.4)",
  fontSize: 10,
  fontVariantNumeric: "tabular-nums",
  marginLeft: "auto",
  flexShrink: 0,
};

const dropdownItemDeleteStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#f87171",
  padding: 2,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "opacity 120ms ease",
  flexShrink: 0,
};

const dropdownItemCommentStyle: CSSProperties = {
  fontSize: 12,
  color: "rgba(226,232,240,0.85)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  marginTop: 2,
};
