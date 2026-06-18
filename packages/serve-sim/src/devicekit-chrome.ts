import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "fs";
import type { ServerResponse } from "http";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";

const DEVICE_TYPES_ROOT = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes";
const CHROME_ROOT = "/Library/Developer/DeviceKit/Chrome";
const CHROME_PREFIX = "com.apple.dt.devicekit.chrome.";
const PNG_CACHE_ROOT = join(tmpdir(), "serve-sim-devicekit-chrome");

type JsonRecord = Record<string, unknown>;

export type DeviceKitChromeDescriptor = {
  identifier: string;
  frame: Size;
  body: Rect;
  screen: Rect;
  insets: Insets;
  outerCornerRadius: number;
  innerCornerRadius: number;
  compositeImage: string | null;
  slice: DeviceKitChromeSlice | null;
  corner: Size | null;
  buttons: DeviceKitChromeButton[];
};

export type DeviceKitChromeButton = {
  name: string;
  image: string;
  onTop: boolean;
  frame: Rect;
};

export type DeviceKitChromeSlice = {
  topLeft: string;
  top: string;
  topRight: string;
  right: string;
  bottomRight: string;
  bottom: string;
  bottomLeft: string;
  left: string;
};

type Size = { width: number; height: number };
type Point = { x: number; y: number };
type Rect = Point & Size;
type Insets = { top: number; left: number; bottom: number; right: number };

type DeviceProfile = {
  chromeIdentifier: string;
  screenSize: Size | null;
};

type ParsedChrome = {
  identifier: string;
  insets: Insets;
  devicePadding: Insets;
  outerCornerRadius: number;
  innerCornerRadius: number;
  compositeImage: string | null;
  slice: DeviceKitChromeSlice | null;
  buttons: ParsedButton[];
  allowedImages: Set<string>;
};

type ParsedButton = {
  name: string;
  image: string;
  onTop: boolean;
  anchor: "left" | "right" | "top" | "bottom";
  align: "leading" | "trailing";
  normalOffset: Point;
  rolloverOffset: Point;
};

let deviceTypeNameByIdentifier: Map<string, string> | null = null;
const chromeCache = new Map<string, ParsedChrome | null>();
const descriptorCache = new Map<string, DeviceKitChromeDescriptor | null>();

export function bareChromeIdentifier(identifier: string): string {
  return identifier.startsWith(CHROME_PREFIX)
    ? identifier.slice(CHROME_PREFIX.length)
    : identifier;
}

export function parsePdfPageSize(pdf: Buffer | string): Size | null {
  const text = typeof pdf === "string" ? pdf : pdf.toString("latin1");
  const box =
    /\/CropBox\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/.exec(text) ??
    /\/MediaBox\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/.exec(text);
  if (!box) return null;
  const x0 = Number(box[1]);
  const y0 = Number(box[2]);
  const x1 = Number(box[3]);
  const y1 = Number(box[4]);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function logicalScreenSizeFromProfile(
  profile: JsonRecord,
  chromeIdentifier: string,
): Size | null {
  const explicit = explicitScreenSize(profile);
  if (explicit) return explicit;

  const mask = typeof profile.framebufferMask === "string" ? profile.framebufferMask : null;
  if (!mask) return null;
  const profileDir = typeof profile.__profileDir === "string" ? profile.__profileDir : null;
  if (!profileDir) return null;
  const maskPath = join(profileDir, `${mask}.pdf`);
  if (!existsSync(maskPath)) return null;
  const size = parsePdfPageSize(readFileSync(maskPath));
  if (!size) return null;

  const scale = fallbackScaleForChrome(chromeIdentifier);
  return { width: size.width / scale, height: size.height / scale };
}

export function resolveDeviceKitChrome(device: {
  name: string;
  deviceTypeIdentifier?: string;
}): DeviceKitChromeDescriptor | null {
  const profileName =
    deviceTypeNameForIdentifier(device.deviceTypeIdentifier) ?? device.name;
  const cacheKey = profileName;
  if (descriptorCache.has(cacheKey)) return descriptorCache.get(cacheKey) ?? null;

  const resolved = resolveDeviceKitChromeUncached(profileName);
  descriptorCache.set(cacheKey, resolved);
  return resolved;
}

export function serveDeviceKitChromeAsset(url: URL, res: ServerResponse): void {
  const identifier = bareChromeIdentifier(url.searchParams.get("chrome") ?? "");
  const imageName = url.searchParams.get("image") ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(identifier) || !imageName) {
    jsonError(res, 400, "Invalid chrome asset request");
    return;
  }

  const chrome = readChrome(identifier);
  if (!chrome || !chrome.allowedImages.has(imageName) || imageName.includes("/")) {
    jsonError(res, 404, "Chrome asset not found");
    return;
  }

  const pdfPath = chromeAssetPath(identifier, imageName);
  if (!existsSync(pdfPath)) {
    jsonError(res, 404, "Chrome asset not found");
    return;
  }

  try {
    const pngPath = cachedPngPath(identifier, imageName, pdfPath);
    const bytes = readFileSync(pngPath);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=604800, immutable",
      "Content-Length": String(bytes.byteLength),
    });
    res.end(bytes);
  } catch (err) {
    jsonError(res, 500, err instanceof Error ? err.message : "Failed to render chrome asset");
  }
}

function resolveDeviceKitChromeUncached(profileName: string): DeviceKitChromeDescriptor | null {
  const profilePath = join(
    DEVICE_TYPES_ROOT,
    `${profileName}.simdevicetype`,
    "Contents",
    "Resources",
    "profile.plist",
  );
  if (!existsSync(profilePath)) return null;

  const profile = readProfile(profilePath);
  if (!profile) return null;
  const chrome = readChrome(profile.chromeIdentifier);
  if (!chrome) return null;

  let bodySize: Size | null = null;
  if (chrome.compositeImage) {
    bodySize = pdfAssetSize(chrome.identifier, chrome.compositeImage);
  }

  const screenSize =
    bodySize
      ? {
          width: bodySize.width - chrome.insets.left - chrome.insets.right,
          height: bodySize.height - chrome.insets.top - chrome.insets.bottom,
        }
      : profile.screenSize;
  if (!screenSize || screenSize.width <= 0 || screenSize.height <= 0) return null;

  const resolvedBodySize = bodySize ?? {
    width: screenSize.width + chrome.insets.left + chrome.insets.right,
    height: screenSize.height + chrome.insets.top + chrome.insets.bottom,
  };

  const body: Rect = {
    x: chrome.devicePadding.left,
    y: chrome.devicePadding.top,
    width: resolvedBodySize.width,
    height: resolvedBodySize.height,
  };
  const frame: Size = {
    width: resolvedBodySize.width + chrome.devicePadding.left + chrome.devicePadding.right,
    height: resolvedBodySize.height + chrome.devicePadding.top + chrome.devicePadding.bottom,
  };
  const screen: Rect = {
    x: body.x + chrome.insets.left,
    y: body.y + chrome.insets.top,
    width: screenSize.width,
    height: screenSize.height,
  };

  const corner = chrome.slice ? pdfAssetSize(chrome.identifier, chrome.slice.topLeft) : null;
  const buttons = chrome.buttons.flatMap((button): DeviceKitChromeButton[] => {
    const imageSize = pdfAssetSize(chrome.identifier, button.image);
    if (!imageSize) return [];
    const topLeft = buttonTopLeft(button, imageSize, resolvedBodySize, chrome.devicePadding);
    return [{
      name: button.name,
      image: button.image,
      onTop: button.onTop,
      frame: { ...topLeft, ...imageSize },
    }];
  });

  return {
    identifier: chrome.identifier,
    frame,
    body,
    screen,
    insets: chrome.insets,
    outerCornerRadius: chrome.outerCornerRadius,
    innerCornerRadius: chrome.innerCornerRadius,
    compositeImage: chrome.compositeImage,
    slice: chrome.slice,
    corner,
    buttons,
  };
}

function readProfile(profilePath: string): DeviceProfile | null {
  const raw = readPlist(profilePath);
  if (!raw) return null;
  const fullIdentifier = typeof raw.chromeIdentifier === "string" ? raw.chromeIdentifier : null;
  if (!fullIdentifier) return null;
  const chromeIdentifier = bareChromeIdentifier(fullIdentifier);
  return {
    chromeIdentifier,
    screenSize: logicalScreenSizeFromProfile(
      { ...raw, __profileDir: dirname(profilePath) },
      chromeIdentifier,
    ),
  };
}

function readChrome(identifier: string): ParsedChrome | null {
  const bare = bareChromeIdentifier(identifier);
  if (!/^[A-Za-z0-9_-]+$/.test(bare)) return null;
  if (chromeCache.has(bare)) return chromeCache.get(bare) ?? null;

  const jsonPath = join(CHROME_ROOT, `${bare}.devicechrome`, "Contents", "Resources", "chrome.json");
  let parsed: ParsedChrome | null = null;
  try {
    const json = JSON.parse(readFileSync(jsonPath, "utf-8")) as JsonRecord;
    parsed = parseChromeJson(json);
  } catch {
    parsed = null;
  }
  chromeCache.set(bare, parsed);
  return parsed;
}

function parseChromeJson(json: JsonRecord): ParsedChrome | null {
  const identifierValue = typeof json.identifier === "string" ? json.identifier : null;
  if (!identifierValue) return null;
  const identifier = bareChromeIdentifier(identifierValue);
  const images = record(json.images);
  const sizing = record(images.sizing);
  const paths = record(json.paths);
  const outerCornerRadius = numberValue(record(paths.simpleOutsideBorder).cornerRadiusX);
  const insets = {
    top: numberValue(sizing.topHeight),
    left: numberValue(sizing.leftWidth),
    bottom: numberValue(sizing.bottomHeight),
    right: numberValue(sizing.rightWidth),
  };
  const devicePaddingJson = record(images.devicePadding);
  const devicePadding = {
    top: numberValue(devicePaddingJson.top),
    left: numberValue(devicePaddingJson.left),
    bottom: numberValue(devicePaddingJson.bottom),
    right: numberValue(devicePaddingJson.right),
  };
  const compositeImage = typeof images.composite === "string" ? images.composite : null;
  const slice = parseSlice(images);
  const buttons = Array.isArray(json.inputs)
    ? json.inputs.flatMap((entry): ParsedButton[] => {
        const button = parseButton(record(entry));
        return button ? [button] : [];
      })
    : [];

  const allowedImages = new Set<string>();
  for (const value of Object.values(images)) {
    if (typeof value === "string") allowedImages.add(value);
  }
  for (const button of buttons) {
    allowedImages.add(button.image);
  }
  if (Array.isArray(json.inputs)) {
    for (const input of json.inputs) {
      const entry = record(input);
      if (typeof entry.imageDown === "string") allowedImages.add(entry.imageDown);
    }
  }

  return {
    identifier,
    insets,
    devicePadding,
    outerCornerRadius,
    innerCornerRadius: Math.max(outerCornerRadius - Math.max(insets.left, insets.top), 0),
    compositeImage,
    slice,
    buttons,
    allowedImages,
  };
}

function parseSlice(images: JsonRecord): DeviceKitChromeSlice | null {
  const topLeft = stringValue(images.topLeft);
  const top = stringValue(images.top);
  const topRight = stringValue(images.topRight);
  const right = stringValue(images.right);
  const bottomRight = stringValue(images.bottomRight);
  const bottom = stringValue(images.bottom);
  const bottomLeft = stringValue(images.bottomLeft);
  const left = stringValue(images.left);
  if (!topLeft || !top || !topRight || !right || !bottomRight || !bottom || !bottomLeft || !left) {
    return null;
  }
  return { topLeft, top, topRight, right, bottomRight, bottom, bottomLeft, left };
}

function parseButton(json: JsonRecord): ParsedButton | null {
  const name = stringValue(json.name);
  const image = stringValue(json.image);
  if (!name || !image) return null;

  const anchorValue = stringValue(json.anchor);
  const alignValue = stringValue(json.align);
  const offsets = record(json.offsets);
  const normal = pointValue(record(offsets.normal));
  const rollover = pointValue(record(offsets.rollover));
  return {
    name,
    image,
    onTop: json.onTop === true,
    anchor:
      anchorValue === "right" || anchorValue === "top" || anchorValue === "bottom"
        ? anchorValue
        : "left",
    align: alignValue === "trailing" ? "trailing" : "leading",
    normalOffset: normal ?? rollover ?? { x: 0, y: 0 },
    rolloverOffset: rollover ?? normal ?? { x: 0, y: 0 },
  };
}

function buttonTopLeft(
  button: ParsedButton,
  imageSize: Size,
  bodySize: Size,
  margins: Insets,
): Point {
  const bodyX = margins.left;
  const bodyY = margins.top;
  switch (button.anchor) {
    case "left": {
      const centerX = bodyX + button.rolloverOffset.x;
      return { x: centerX - imageSize.width / 2, y: bodyY + button.rolloverOffset.y };
    }
    case "right": {
      const restX = 2 * button.normalOffset.x - button.rolloverOffset.x;
      const restY = 2 * button.normalOffset.y - button.rolloverOffset.y;
      return { x: bodyX + bodySize.width + restX, y: bodyY + restY };
    }
    case "top": {
      const restX = 2 * button.normalOffset.x - button.rolloverOffset.x;
      const restY = 2 * button.normalOffset.y - button.rolloverOffset.y;
      const x = button.align === "trailing"
        ? bodyX + bodySize.width + restX - imageSize.width
        : bodyX + restX;
      return { x, y: bodyY + restY - imageSize.height };
    }
    case "bottom": {
      const restX = 2 * button.normalOffset.x - button.rolloverOffset.x;
      const restY = 2 * button.normalOffset.y - button.rolloverOffset.y;
      const x = button.align === "trailing"
        ? bodyX + bodySize.width + restX - imageSize.width
        : bodyX + restX;
      return { x, y: bodyY + bodySize.height + restY };
    }
  }
}

function deviceTypeNameForIdentifier(identifier: string | undefined): string | null {
  if (!identifier) return null;
  if (!deviceTypeNameByIdentifier) {
    deviceTypeNameByIdentifier = buildDeviceTypeNameMap();
  }
  return deviceTypeNameByIdentifier.get(identifier) ?? null;
}

function buildDeviceTypeNameMap(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const entry of readdirSync(DEVICE_TYPES_ROOT)) {
      if (!entry.endsWith(".simdevicetype")) continue;
      const bundlePath = join(DEVICE_TYPES_ROOT, entry);
      const info = readPlist(join(bundlePath, "Contents", "Info.plist"));
      const identifier = typeof info?.CFBundleIdentifier === "string" ? info.CFBundleIdentifier : null;
      const name = typeof info?.CFBundleName === "string"
        ? info.CFBundleName
        : basename(entry, ".simdevicetype");
      if (identifier) out.set(identifier, name);
    }
  } catch {}
  return out;
}

function readPlist(path: string): JsonRecord | null {
  try {
    const json = execFileSync("plutil", ["-convert", "json", "-o", "-", path], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    return JSON.parse(json) as JsonRecord;
  } catch {
    return null;
  }
}

function explicitScreenSize(profile: JsonRecord): Size | null {
  const width = numberOrNull(profile.mainScreenWidth);
  const height = numberOrNull(profile.mainScreenHeight);
  const scale = numberOrNull(profile.mainScreenScale);
  if (!width || !height || !scale || scale <= 0) return null;
  return { width: width / scale, height: height / scale };
}

function fallbackScaleForChrome(identifier: string): number {
  if (identifier.startsWith("phone")) return 3;
  if (identifier.startsWith("tablet")) return 2;
  if (identifier.startsWith("watch")) return 2;
  return 1;
}

function pdfAssetSize(identifier: string, imageName: string): Size | null {
  const path = chromeAssetPath(identifier, imageName);
  if (!existsSync(path)) return null;
  return parsePdfPageSize(readFileSync(path));
}

function chromeAssetPath(identifier: string, imageName: string): string {
  return join(CHROME_ROOT, `${identifier}.devicechrome`, "Contents", "Resources", `${imageName}.pdf`);
}

function cachedPngPath(identifier: string, imageName: string, pdfPath: string): string {
  mkdirSync(PNG_CACHE_ROOT, { recursive: true });
  const stat = statSync(pdfPath);
  const key = createHash("sha1")
    .update(identifier)
    .update("\0")
    .update(imageName)
    .update("\0")
    .update(String(stat.mtimeMs))
    .update("\0")
    .update(String(stat.size))
    .digest("hex");
  const outPath = join(PNG_CACHE_ROOT, `${identifier}-${key}.png`);
  if (existsSync(outPath)) return outPath;

  const tmpPath = `${outPath}.${process.pid}.tmp`;
  execFileSync("sips", ["-s", "format", "png", pdfPath, "--out", tmpPath], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 10_000,
  });
  renameSync(tmpPath, outPath);
  return outPath;
}

function jsonError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ ok: false, error }));
}

function numberValue(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function pointValue(value: JsonRecord): Point | null {
  const x = numberOrNull(value.x);
  const y = numberOrNull(value.y);
  return x === null || y === null ? null : { x, y };
}
