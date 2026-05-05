/**
 * Storage layer for comment annotations.
 *
 * On-disk layout (rooted at $TMPDIR/serve-sim/annotations):
 *   {udid}/annotations.jsonl   — append-only JSON Lines, one Annotation per line
 *   {udid}/crops/anno-{id}.jpg — JPEG crops referenced by Annotation.screenshotPath
 *   {udid}/frames/anno-{id}.jpg — optional full-frame JPEGs
 *
 * Per-device segregation matches serve-sim's existing convention (each helper
 * tracks its own device under STATE_DIR/server-{udid}.json). It also keeps
 * cross-tab / multi-sim sessions tidy: kill one sim → its annotations stay,
 * but they don't pollute another sim's dropdown.
 *
 * Concurrency: append-only JSONL means a writer only ever does
 * `fs.appendFile`, so multiple processes (CLI + middleware) can each append
 * without corrupting state. Updates and deletes rewrite the file under a
 * single in-process lock.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import type {
  Annotation,
  AnnotationCreateRequest,
  AnnotationStatus,
  AnnotationUpdateRequest,
} from "./annotations-shared";

const ROOT = join(tmpdir(), "serve-sim", "annotations");

function deviceDir(udid: string) {
  return join(ROOT, sanitizeUdid(udid));
}

function jsonlPath(udid: string) {
  return join(deviceDir(udid), "annotations.jsonl");
}

function cropsDir(udid: string) {
  return join(deviceDir(udid), "crops");
}

function framesDir(udid: string) {
  return join(deviceDir(udid), "frames");
}

/**
 * UDIDs are well-formed UUIDs in practice, but defensive sanitation prevents
 * a hostile or malformed value from breaking out of the annotations root.
 */
function sanitizeUdid(udid: string): string {
  return udid.replace(/[^A-Za-z0-9._-]/g, "_");
}

function ensureDeviceLayout(udid: string) {
  mkdirSync(cropsDir(udid), { recursive: true });
  mkdirSync(framesDir(udid), { recursive: true });
}

/** 12-hex-char ID, URL-safe and short enough to fit in a filename. */
function newId(): string {
  return randomBytes(6).toString("hex");
}

/** Strip the `data:image/jpeg;base64,` prefix and decode. */
function decodeDataUri(uri: string): Buffer | null {
  const match = /^data:image\/(?:jpeg|jpg|png);base64,(.+)$/.exec(uri);
  if (!match) return null;
  try {
    return Buffer.from(match[1]!, "base64");
  } catch {
    return null;
  }
}

export function listAnnotations(udid: string): Annotation[] {
  const path = jsonlPath(udid);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: Annotation[] = [];
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Annotation;
      if (parsed && typeof parsed === "object" && parsed.id) out.push(parsed);
    } catch {
      // Skip malformed lines silently — append-only logs occasionally have a
      // partial last line if the writer crashed mid-flush.
    }
  }
  return out;
}

export function getAnnotation(udid: string, id: string): Annotation | null {
  return listAnnotations(udid).find((a) => a.id === id) ?? null;
}

export interface CreatedAnnotation {
  annotation: Annotation;
}

export function createAnnotation(
  req: AnnotationCreateRequest,
): CreatedAnnotation | { error: string } {
  if (!req?.device?.udid) return { error: "device.udid required" };
  if (typeof req.comment !== "string") return { error: "comment required" };
  if (!req.cropDataUri) return { error: "cropDataUri required" };
  const cropBytes = decodeDataUri(req.cropDataUri);
  if (!cropBytes) return { error: "cropDataUri must be a data:image/* URI" };

  ensureDeviceLayout(req.device.udid);

  const id = newId();
  const cropFilename = `anno-${id}.jpg`;
  const cropAbs = join(cropsDir(req.device.udid), cropFilename);
  writeFileSync(cropAbs, cropBytes);

  let fullFramePath: string | undefined;
  if (req.fullFrameDataUri) {
    const fullBytes = decodeDataUri(req.fullFrameDataUri);
    if (fullBytes) {
      const filename = `anno-${id}.jpg`;
      writeFileSync(join(framesDir(req.device.udid), filename), fullBytes);
      fullFramePath = `frames/${filename}`;
    }
  }

  const annotation: Annotation = {
    id,
    createdAt: new Date().toISOString(),
    device: { udid: req.device.udid, name: req.device.name ?? "" },
    point: req.point,
    region: req.region,
    screenshotPath: `crops/${cropFilename}`,
    fullFramePath,
    context: req.context,
    comment: req.comment,
    status: "pending",
  };

  appendFileSync(jsonlPath(req.device.udid), JSON.stringify(annotation) + "\n");
  return { annotation };
}

export function updateAnnotation(
  udid: string,
  id: string,
  patch: AnnotationUpdateRequest,
): Annotation | null {
  const all = listAnnotations(udid);
  const idx = all.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const current = all[idx]!;
  const next: Annotation = {
    ...current,
    comment: typeof patch.comment === "string" ? patch.comment : current.comment,
    status: isStatus(patch.status) ? patch.status : current.status,
  };
  all[idx] = next;
  rewriteJsonl(udid, all);
  return next;
}

export function deleteAnnotation(udid: string, id: string): boolean {
  const all = listAnnotations(udid);
  const target = all.find((a) => a.id === id);
  if (!target) return false;
  const remaining = all.filter((a) => a.id !== id);
  rewriteJsonl(udid, remaining);
  // Best-effort cleanup of crop / frame on disk.
  tryUnlink(join(deviceDir(udid), target.screenshotPath));
  if (target.fullFramePath) {
    tryUnlink(join(deviceDir(udid), target.fullFramePath));
  }
  return true;
}

export function deleteAllAnnotations(udid: string): number {
  const all = listAnnotations(udid);
  for (const anno of all) {
    tryUnlink(join(deviceDir(udid), anno.screenshotPath));
    if (anno.fullFramePath) tryUnlink(join(deviceDir(udid), anno.fullFramePath));
  }
  rewriteJsonl(udid, []);
  return all.length;
}

/** Resolve a relative path stored in `Annotation.screenshotPath` to absolute. */
export function resolveAnnotationAsset(
  udid: string,
  relativePath: string,
): string | null {
  // Reject path traversal — relativePath comes from disk but is reflected in
  // HTTP responses, and the GET /:id/crop handler maps id → file via this.
  if (relativePath.includes("..")) return null;
  const abs = join(deviceDir(udid), relativePath);
  if (!existsSync(abs)) return null;
  return abs;
}

function rewriteJsonl(udid: string, annotations: Annotation[]) {
  ensureDeviceLayout(udid);
  const body = annotations.map((a) => JSON.stringify(a)).join("\n");
  writeFileSync(jsonlPath(udid), body ? body + "\n" : "");
}

function isStatus(value: unknown): value is AnnotationStatus {
  return value === "pending" || value === "sent" || value === "archived";
}

function tryUnlink(path: string) {
  try {
    unlinkSync(path);
  } catch {}
}

export const ANNOTATIONS_ROOT = ROOT;
