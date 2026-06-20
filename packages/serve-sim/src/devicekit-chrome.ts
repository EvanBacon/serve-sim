import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import type { ServerResponse } from "http";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { inflateSync } from "zlib";

const DEVICE_TYPES_ROOT = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes";
const CHROME_ROOT = "/Library/Developer/DeviceKit/Chrome";
const CHROME_PREFIX = "com.apple.dt.devicekit.chrome.";
const PNG_CACHE_ROOT = join(tmpdir(), "serve-sim-devicekit-chrome");
const PLACEHOLDER_ASSET_CACHE_ROOT = join(tmpdir(), "serve-sim-device-placeholder-assets");
const MOBILE_DEVICE_RESOURCES_ROOT =
  "/System/Library/CoreServices/CoreTypes.bundle/Contents/Library/MobileDevices.bundle/Contents/Resources";
const LEGACY_CORE_TYPES_RESOURCES_ROOT =
  "/System/Library/CoreServices/CoreTypes.bundle/Contents/Library/CoreTypes-0006.bundle/Contents/Resources";

type JsonRecord = Record<string, unknown>;
type PlaceholderAssetInfo = { sourcePath: string; pngPath: string; width: number; height: number };
type PlaceholderAssetDefinition = {
  paths: readonly string[];
};

const FALLBACK_PLACEHOLDER_ASSETS = {
  "vision-pro": {
    paths: [
      join(MOBILE_DEVICE_RESOURCES_ROOT, "com.apple.vision-pro.icns"),
      join(LEGACY_CORE_TYPES_RESOURCES_ROOT, "com.apple.visionpro.icns"),
    ],
  },
  "iphone-17e": { paths: [join(MOBILE_DEVICE_RESOURCES_ROOT, "com.apple.iphone-16-e-1.icns")] },
  "ipad-air-11-inch-m4": { paths: [join(MOBILE_DEVICE_RESOURCES_ROOT, "com.apple.ipad-air-m3-1.icns")] },
  "ipad-air-13-inch-m4": { paths: [join(MOBILE_DEVICE_RESOURCES_ROOT, "com.apple.ipad-air-m3-1.icns")] },
} as const satisfies Record<string, PlaceholderAssetDefinition>;

type FallbackPlaceholderAssetName = keyof typeof FALLBACK_PLACEHOLDER_ASSETS;

type CoreTypesIconEntry = {
  description: string;
  iconFile: string;
  iconName: string;
  modelCodes: string[];
};

export type DevicePlaceholderAssetDescriptor = {
  name: string;
  width: number;
  height: number;
};

export type DeviceKitChromeDescriptor = {
  identifier: string;
  frame: Size;
  body: Rect;
  screen: Rect;
  insets: Insets;
  outerCornerRadius: number;
  innerCornerRadius: number;
  /** The active screen's corner radius (composite px) for rounding the stream. */
  screenRadius: number;
  compositeImage: string | null;
  slice: DeviceKitChromeSlice | null;
  corner: Size | null;
  buttons: DeviceKitChromeButton[];
};

export type DeviceKitChromeButton = {
  name: string;
  image: string;
  /** Pressed-state sprite (chrome.json `imageDown`), shown while held. */
  imageDown: string | null;
  onTop: boolean;
  frame: Rect;
  /** Hover/press travel as a fraction of the button image (rollover − normal). */
  hover: Point;
  /** HID (page, usage) from chrome.json — dispatched via arbitrary HID injection
   * when the button is pressed in the live view. Null for inputs without codes. */
  usagePage: number | null;
  usage: number | null;
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

type DeviceProfileMetadata = {
  chromeIdentifier: string | null;
  modelIdentifier: string | null;
  productClass: string | null;
  screenSize: Size | null;
  /** Raw framebuffer-mask PDF size — Apple's active-display shape, but in
   * inconsistent units across families (iPhone @3x px, watch @1x pt). */
  framebufferMaskSize: Size | null;
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
  imageDown: string | null;
  onTop: boolean;
  anchor: "left" | "right" | "top" | "bottom";
  align: "leading" | "trailing";
  normalOffset: Point;
  rolloverOffset: Point;
  usagePage: number | null;
  usage: number | null;
};

let deviceTypeNameByIdentifier: Map<string, string> | null = null;
const chromeCache = new Map<string, ParsedChrome | null>();
const descriptorCache = new Map<string, DeviceKitChromeDescriptor | null>();
const placeholderDescriptorCache = new Map<string, DevicePlaceholderAssetDescriptor | null>();
let coreTypesIconEntriesCache: CoreTypesIconEntry[] | null = null;
const placeholderAssetInfoCache = new Map<string, PlaceholderAssetInfo | null>();

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
  const profileName = profileNameForDevice(device);
  const cacheKey = profileName;
  if (descriptorCache.has(cacheKey)) return descriptorCache.get(cacheKey) ?? null;

  const resolved = resolveDeviceKitChromeUncached(profileName);
  descriptorCache.set(cacheKey, resolved);
  return resolved;
}

export function resolveDevicePlaceholderAsset(device: {
  name: string;
  deviceTypeIdentifier?: string;
}): DevicePlaceholderAssetDescriptor | null {
  // Keyed by the same profile name as descriptorCache so repeated /grid/api
  // requests don't re-spawn `plutil` (and re-read the PDF mask) per device.
  const cacheKey = profileNameForDevice(device);
  if (placeholderDescriptorCache.has(cacheKey)) {
    return placeholderDescriptorCache.get(cacheKey) ?? null;
  }

  const resolved = resolveDevicePlaceholderAssetUncached(device);
  placeholderDescriptorCache.set(cacheKey, resolved);
  return resolved;
}

function resolveDevicePlaceholderAssetUncached(device: {
  name: string;
  deviceTypeIdentifier?: string;
}): DevicePlaceholderAssetDescriptor | null {
  const profilePath = profilePathForDevice(device);
  const profile = profilePath ? readProfileMetadata(profilePath) : null;
  const iconName =
    iconNameForProfile(profile) ??
    fallbackIconNameForDeviceName(device.name);
  if (!iconName) return null;

  const info = placeholderAssetInfo(iconName);
  return info ? { name: iconName, width: info.width, height: info.height } : null;
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

export function serveDevicePlaceholderAsset(url: URL, res: ServerResponse): void {
  const name = url.searchParams.get("name") ?? "";
  try {
    const asset = placeholderAssetInfo(name);
    if (!asset) {
      jsonError(res, 404, "Placeholder asset not found");
      return;
    }

    const bytes = readFileSync(asset.pngPath);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=604800, immutable",
      "Content-Length": String(bytes.byteLength),
    });
    res.end(bytes);
  } catch (err) {
    jsonError(res, 500, err instanceof Error ? err.message : "Failed to render placeholder asset");
  }
}

function placeholderAssetInfo(name: string): PlaceholderAssetInfo | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (placeholderAssetInfoCache.has(name)) return placeholderAssetInfoCache.get(name) ?? null;

  const sourcePath = placeholderAssetSourcePath(name);
  const info = sourcePath ? cachedPlaceholderAssetPngPath(name, sourcePath) : null;
  placeholderAssetInfoCache.set(name, info);
  return info;
}

function placeholderAssetSourcePath(name: string): string | null {
  const fallback = fallbackPlaceholderAsset(name);
  const fallbackPath = fallback?.paths.find((path) => existsSync(path));
  if (fallbackPath) return fallbackPath;

  if (!coreTypesIconEntries().some((entry) => entry.iconName === name)) return null;
  const path = join(MOBILE_DEVICE_RESOURCES_ROOT, `${name}.icns`);
  return existsSync(path) ? path : null;
}

function fallbackPlaceholderAsset(name: string): PlaceholderAssetDefinition | null {
  return Object.prototype.hasOwnProperty.call(FALLBACK_PLACEHOLDER_ASSETS, name)
    ? FALLBACK_PLACEHOLDER_ASSETS[name as FallbackPlaceholderAssetName]
    : null;
}

function resolveDeviceKitChromeUncached(profileName: string): DeviceKitChromeDescriptor | null {
  const profilePath = profilePathForName(profileName);
  if (!existsSync(profilePath)) return null;

  const profile = readProfileMetadata(profilePath);
  if (!profile?.chromeIdentifier) return null;
  const chrome = readChrome(profile.chromeIdentifier);
  if (!chrome) return null;

  let bodySize: Size | null = null;
  if (chrome.compositeImage) {
    bodySize = pdfAssetSize(chrome.identifier, chrome.compositeImage);
  }

  // The active display size, in composite points. Apple's framebuffer mask is
  // the display shape but in inconsistent units across families (iPhone @3x px,
  // watch @1x pt), so the per-family fallback scale is wrong for some devices.
  // Derive the real scale from the composite's own black-screen opening
  // (mask px ÷ opening pt → 3 for iPhone, 1 for watch) and convert. Nine-slice
  // chrome (no composite) keeps the profile's logical screen, which is correct
  // for it; `bodySize − insets` is the last-resort fallback.
  const opening = chrome.compositeImage
    ? compositeScreenBounds(chrome.identifier, chrome.compositeImage)
    : null;
  const screenSize =
    (opening && profile.framebufferMaskSize
      ? scaleMaskToPoints(profile.framebufferMaskSize, opening)
      : null) ??
    profile.screenSize ??
    (bodySize
      ? {
          width: bodySize.width - chrome.insets.left - chrome.insets.right,
          height: bodySize.height - chrome.insets.top - chrome.insets.bottom,
        }
      : null);
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
  // The active screen, centered in the device body (the case). The stream renders
  // here ON TOP of the bezel; the composite's own black screen border (between
  // the metal edge and this rect) frames it like a real device's display border.
  const screen: Rect = {
    x: body.x + (resolvedBodySize.width - screenSize.width) / 2,
    y: body.y + (resolvedBodySize.height - screenSize.height) / 2,
    width: screenSize.width,
    height: screenSize.height,
  };
  // The screen's own corner radius. innerCornerRadius (outer − inset) is right
  // for the iPhone but far too small for the watch's very rounded display, so
  // measure the composite's screen-cutout radius and step it in by the same
  // amount the active display is inset from that cutout.
  const screenRadius = opening
    ? Math.max(0, opening.radius - (opening.width - screenSize.width) / 2)
    : chrome.innerCornerRadius;

  const corner = chrome.slice ? pdfAssetSize(chrome.identifier, chrome.slice.topLeft) : null;
  // Watch caps (crown / side / action) always render above the bezel so the
  // whole cap shows and is the hit target; iPhone/iPad buttons only honor the
  // per-button `onTop` flag and otherwise sit behind the bezel's edge.
  const capsOnTop = chrome.identifier.startsWith("watch");
  const buttons = chrome.buttons.flatMap((button): DeviceKitChromeButton[] => {
    const imageSize = pdfAssetSize(chrome.identifier, button.image);
    if (!imageSize) return [];
    const topLeft = buttonTopLeft(button, imageSize, resolvedBodySize, chrome.devicePadding);
    // Hover/press travel: the cap slides from rest toward the rollover offset.
    // Expressed as a fraction of the button image so the client can translate it.
    const hover = {
      x: imageSize.width > 0 ? (button.rolloverOffset.x - button.normalOffset.x) / imageSize.width : 0,
      y: imageSize.height > 0 ? (button.rolloverOffset.y - button.normalOffset.y) / imageSize.height : 0,
    };
    return [{
      name: button.name,
      image: button.image,
      imageDown: button.imageDown,
      onTop: button.onTop || capsOnTop,
      frame: { ...topLeft, ...imageSize },
      hover,
      usagePage: button.usagePage,
      usage: button.usage,
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
    screenRadius,
    compositeImage: chrome.compositeImage,
    slice: chrome.slice,
    corner,
    buttons,
  };
}

function readProfileMetadata(profilePath: string): DeviceProfileMetadata | null {
  const raw = readPlist(profilePath);
  if (!raw) return null;
  const fullIdentifier = typeof raw.chromeIdentifier === "string" ? raw.chromeIdentifier : null;
  const chromeIdentifier = fullIdentifier ? bareChromeIdentifier(fullIdentifier) : null;
  return {
    chromeIdentifier,
    modelIdentifier: typeof raw.modelIdentifier === "string" ? raw.modelIdentifier : null,
    productClass: typeof raw.productClass === "string" ? raw.productClass : null,
    screenSize: chromeIdentifier
      ? logicalScreenSizeFromProfile(
          { ...raw, __profileDir: dirname(profilePath) },
          chromeIdentifier,
        )
      : null,
    framebufferMaskSize: framebufferMaskSize({ ...raw, __profileDir: dirname(profilePath) }),
  };
}

function framebufferMaskSize(profile: JsonRecord): Size | null {
  const mask = typeof profile.framebufferMask === "string" ? profile.framebufferMask : null;
  const profileDir = typeof profile.__profileDir === "string" ? profile.__profileDir : null;
  if (!mask || !profileDir) return null;
  const maskPath = join(profileDir, `${mask}.pdf`);
  if (!existsSync(maskPath)) return null;
  return parsePdfPageSize(readFileSync(maskPath));
}

function profileNameForDevice(device: {
  name: string;
  deviceTypeIdentifier?: string;
}): string {
  return deviceTypeNameForIdentifier(device.deviceTypeIdentifier) ?? device.name;
}

function profilePathForDevice(device: {
  name: string;
  deviceTypeIdentifier?: string;
}): string | null {
  const path = profilePathForName(profileNameForDevice(device));
  return existsSync(path) ? path : null;
}

function profilePathForName(profileName: string): string {
  return join(
    DEVICE_TYPES_ROOT,
    `${profileName}.simdevicetype`,
    "Contents",
    "Resources",
    "profile.plist",
  );
}

function iconNameForProfile(profile: DeviceProfileMetadata | null): string | null {
  if (!profile) return null;
  const candidates = new Set<string>();
  if (profile.modelIdentifier) candidates.add(profile.modelIdentifier);
  if (profile.productClass) {
    candidates.add(profile.productClass);
    candidates.add(`${profile.productClass}AP`);
  }
  if (candidates.size === 0) return null;

  for (const entry of coreTypesIconEntries()) {
    if (entry.modelCodes.some((code) => candidates.has(code))) {
      return entry.iconName;
    }
  }
  return null;
}

function fallbackIconNameForDeviceName(name: string): string | null {
  const normalized = name.toLowerCase();
  if (normalized.includes("vision")) return "vision-pro";
  if (/iphone\s+17e\b/.test(normalized)) return "iphone-17e";
  if (/ipad\s+air\s+11-inch\s+\(m4\)/.test(normalized)) return "ipad-air-11-inch-m4";
  if (/ipad\s+air\s+13-inch\s+\(m4\)/.test(normalized)) return "ipad-air-13-inch-m4";
  return null;
}

function coreTypesIconEntries(): CoreTypesIconEntry[] {
  if (coreTypesIconEntriesCache) return coreTypesIconEntriesCache;
  const info =
    readPlist(join(MOBILE_DEVICE_RESOURCES_ROOT, "MobileDevices-Info.plist")) ??
    readPlist(join(dirname(MOBILE_DEVICE_RESOURCES_ROOT), "Info.plist"));
  const declarations = Array.isArray(info?.UTExportedTypeDeclarations)
    ? info.UTExportedTypeDeclarations
    : [];
  const entries: CoreTypesIconEntry[] = [];
  for (const declaration of declarations) {
    const recordValue = record(declaration);
    const iconFile = stringValue(recordValue.UTTypeIconFile);
    if (!iconFile || !iconFile.endsWith(".icns")) continue;
    const iconPath = join(MOBILE_DEVICE_RESOURCES_ROOT, iconFile);
    if (!existsSync(iconPath)) continue;
    const tags = record(recordValue.UTTypeTagSpecification);
    const rawCodes = tags["com.apple.device-model-code"];
    const modelCodes = Array.isArray(rawCodes)
      ? rawCodes.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    if (modelCodes.length === 0) continue;
    entries.push({
      description: stringValue(recordValue.UTTypeDescription) ?? "",
      iconFile,
      iconName: basename(iconFile, ".icns"),
      modelCodes,
    });
  }
  coreTypesIconEntriesCache = entries;
  return entries;
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
    imageDown: stringValue(json.imageDown),
    onTop: json.onTop === true,
    anchor:
      anchorValue === "right" || anchorValue === "top" || anchorValue === "bottom"
        ? anchorValue
        : "left",
    align: alignValue === "trailing" ? "trailing" : "leading",
    normalOffset: normal ?? rollover ?? { x: 0, y: 0 },
    rolloverOffset: rollover ?? normal ?? { x: 0, y: 0 },
    usagePage: numberOrNull(json.usagePage),
    usage: numberOrNull(json.usage),
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
  // The rest position mirrors the rollover offset back across the normal offset.
  const restX = 2 * button.normalOffset.x - button.rolloverOffset.x;
  const restY = 2 * button.normalOffset.y - button.rolloverOffset.y;
  const alignedX = button.align === "trailing"
    ? bodyX + bodySize.width + restX - imageSize.width
    : bodyX + restX;
  switch (button.anchor) {
    case "left": {
      const centerX = bodyX + button.rolloverOffset.x;
      return { x: centerX - imageSize.width / 2, y: bodyY + button.rolloverOffset.y };
    }
    case "right":
      return { x: bodyX + bodySize.width + restX, y: bodyY + restY };
    case "top":
      return { x: alignedX, y: bodyY + restY - imageSize.height };
    case "bottom":
      return { x: alignedX, y: bodyY + bodySize.height + restY };
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

function cachedPlaceholderAssetPngPath(
  name: string,
  sourcePath: string,
): PlaceholderAssetInfo {
  mkdirSync(PLACEHOLDER_ASSET_CACHE_ROOT, { recursive: true });
  const stat = statSync(sourcePath);
  const key = createHash("sha1")
    .update(name)
    .update("\0")
    .update(sourcePath)
    .update("\0")
    .update(String(stat.mtimeMs))
    .update("\0")
    .update(String(stat.size))
    .digest("hex");
  const outPath = join(PLACEHOLDER_ASSET_CACHE_ROOT, `${name}-${key}.png`);
  if (existsSync(outPath)) {
    const size = pngSize(readFileSync(outPath));
    return { sourcePath, pngPath: outPath, width: size.width, height: size.height };
  }

  const tmpPath = `${outPath}.${process.pid}.tmp`;
  const rawPath = `${outPath}.${process.pid}.raw.png`;
  try {
    execFileSync("sips", ["-s", "format", "png", sourcePath, "--out", rawPath], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10_000,
    });
    const rawPng = readFileSync(rawPath);
    const crop = alphaBounds(rawPng) ?? { x: 0, y: 0, ...pngSize(rawPng) };
    execFileSync(
      "sips",
      [
        "-c",
        String(crop.height),
        String(crop.width),
        "--cropOffset",
        String(crop.y),
        String(crop.x),
        "-s",
        "format",
        "png",
        sourcePath,
        "--out",
        tmpPath,
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 10_000,
      },
    );
    renameSync(tmpPath, outPath);
    return { sourcePath, pngPath: outPath, width: crop.width, height: crop.height };
  } finally {
    try {
      if (existsSync(rawPath)) unlinkSync(rawPath);
    } catch {}
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {}
  }
}

function pngSize(png: Buffer): Size {
  if (
    png.byteLength < 24 ||
    png[0] !== 0x89 ||
    png.toString("ascii", 1, 4) !== "PNG"
  ) {
    throw new Error("Invalid PNG placeholder asset");
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

type PixelPredicate = (r: number, g: number, b: number, a: number) => boolean;
type PixelMask = { width: number; height: number; mask: Uint8Array };

/** Decode an 8-bit RGBA/GA PNG into a per-pixel boolean mask of `predicate`. */
function decodeMask(png: Buffer, predicate: PixelPredicate): PixelMask | null {
  const { width, height } = pngSize(png);
  let offset = 8;
  let bitDepth = 0;
  let colorType = 0;
  const idats: Buffer[] = [];
  while (offset < png.byteLength) {
    const length = png.readUInt32BE(offset);
    offset += 4;
    const type = png.toString("ascii", offset, offset + 4);
    offset += 4;
    const data = png.subarray(offset, offset + length);
    offset += length + 4;
    if (type === "IHDR") {
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  const bytesPerPixel = colorType === 6 ? 4 : colorType === 4 ? 2 : 0;
  if (bitDepth !== 8 || bytesPerPixel === 0 || idats.length === 0) {
    return null;
  }
  const rgba = colorType === 6;

  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * bytesPerPixel;
  const mask = new Uint8Array(width * height);
  let previous = Buffer.alloc(stride);
  let inputOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[inputOffset++] ?? 0;
    const row = Buffer.from(raw.subarray(inputOffset, inputOffset + stride));
    inputOffset += stride;
    unfilterPngRow(row, previous, bytesPerPixel, filter);

    for (let x = 0; x < width; x++) {
      const base = x * bytesPerPixel;
      const r = row[base] ?? 0;
      const g = rgba ? row[base + 1] ?? 0 : r;
      const b = rgba ? row[base + 2] ?? 0 : r;
      const a = row[base + bytesPerPixel - 1] ?? 0;
      if (predicate(r, g, b, a)) mask[y * width + x] = 1;
    }
    previous = row;
  }
  return { width, height, mask };
}

function alphaBounds(png: Buffer): Rect | null {
  const { width, height } = pngSize(png);
  const decoded = decodeMask(png, (_r, _g, _b, a) => a > 0);
  if (!decoded) return { x: 0, y: 0, width, height };
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!decoded.mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return { x: 0, y: 0, width, height };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Convert Apple's framebuffer-mask size into composite points using the
 * composite's own black-screen opening as the scale reference (mask px ÷
 * opening pt, rounded). Handles the per-family unit inconsistency uniformly.
 */
function scaleMaskToPoints(mask: Size, opening: Rect): Size | null {
  if (opening.width <= 0) return null;
  const scale = Math.max(1, Math.round(mask.width / opening.width));
  return { width: mask.width / scale, height: mask.height / scale };
}

/**
 * The composite's black-screen opening (the cutout Apple fills with opaque
 * black). Found by walking the contiguous black region out from the screen
 * center along the center row + column, so dark metal / button slots elsewhere
 * don't inflate the rect. In the composite's own pixel/point coordinates.
 */
function compositeScreenBounds(identifier: string, imageName: string): (Rect & { radius: number }) | null {
  const png = readCompositePng(identifier, imageName);
  if (!png) return null;
  const decoded = decodeMask(png, (r, g, b, a) => a > 200 && r < 30 && g < 30 && b < 30);
  if (!decoded) return null;
  const { width, height, mask } = decoded;
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const dark = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  if (!dark(cx, cy)) return null;
  let x0 = cx;
  while (x0 > 0 && dark(x0 - 1, cy)) x0--;
  let x1 = cx;
  while (x1 < width - 1 && dark(x1 + 1, cy)) x1++;
  let y0 = cy;
  while (y0 > 0 && dark(cx, y0 - 1)) y0--;
  let y1 = cy;
  while (y1 < height - 1 && dark(cx, y1 + 1)) y1++;
  // Corner radius: down each corner column the rounded corner stays non-dark for
  // ~r rows. Averaged over the four corners (innerCornerRadius is wrong for the
  // watch's very rounded screen).
  const span = y1 - y0;
  const cornerInset = (x: number, fromTop: boolean) => {
    let n = 0;
    while (n < span && !dark(x, fromTop ? y0 + n : y1 - n)) n++;
    return n;
  };
  const radii = [cornerInset(x0, true), cornerInset(x1, true), cornerInset(x0, false), cornerInset(x1, false)];
  const radius = radii.reduce((a, b) => a + b, 0) / radii.length;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, radius };
}

function readCompositePng(identifier: string, imageName: string): Buffer | null {
  const pdfPath = chromeAssetPath(identifier, imageName);
  if (!existsSync(pdfPath)) return null;
  try {
    return readFileSync(cachedPngPath(identifier, imageName, pdfPath));
  } catch {
    return null;
  }
}

function unfilterPngRow(
  row: Buffer,
  previous: Buffer,
  bytesPerPixel: number,
  filter: number,
): void {
  for (let i = 0; i < row.byteLength; i++) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel]! : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel]! : 0;
    switch (filter) {
      case 0:
        break;
      case 1:
        row[i] = (row[i]! + left) & 0xff;
        break;
      case 2:
        row[i] = (row[i]! + up) & 0xff;
        break;
      case 3:
        row[i] = (row[i]! + Math.floor((left + up) / 2)) & 0xff;
        break;
      case 4:
        row[i] = (row[i]! + paeth(left, up, upLeft)) & 0xff;
        break;
      default:
        throw new Error(`Unsupported PNG filter ${filter}`);
    }
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
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
