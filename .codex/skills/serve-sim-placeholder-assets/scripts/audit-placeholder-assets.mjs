#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { inflateSync } from "node:zlib";

const deviceTypesRoot = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes";
const mobileResourcesRoot =
  "/System/Library/CoreServices/CoreTypes.bundle/Contents/Library/MobileDevices.bundle/Contents/Resources";
const legacyResourcesRoot =
  "/System/Library/CoreServices/CoreTypes.bundle/Contents/Library/CoreTypes-0006.bundle/Contents/Resources";

const fallbackAssets = [
  {
    pattern: /Apple Vision Pro/i,
    name: "vision-pro",
    iconFiles: [
      join(mobileResourcesRoot, "com.apple.vision-pro.icns"),
      join(legacyResourcesRoot, "com.apple.visionpro.icns"),
    ],
    reason: "legacy CoreTypes fallback path",
  },
  {
    pattern: /^iPhone 17e$/i,
    name: "iphone-17e",
    iconFiles: [join(mobileResourcesRoot, "com.apple.iphone-16-e-1.icns")],
    reason: "CoreTypes has no iPhone 17e icon yet",
  },
  {
    pattern: /^iPad Air 11-inch \(M4\)$/i,
    name: "ipad-air-11-inch-m4",
    iconFiles: [join(mobileResourcesRoot, "com.apple.ipad-air-m3-1.icns")],
    reason: "CoreTypes has no M4 Air icon yet",
  },
  {
    pattern: /^iPad Air 13-inch \(M4\)$/i,
    name: "ipad-air-13-inch-m4",
    iconFiles: [join(mobileResourcesRoot, "com.apple.ipad-air-m3-1.icns")],
    reason: "CoreTypes has no M4 Air icon yet",
  },
];

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const render = !args.has("--no-render");
const outDir = valueAfter("--out") ?? "tmp/device-placeholder-assets";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readPlist(path) {
  try {
    return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }));
  } catch {
    return null;
  }
}

function coreTypesEntries() {
  const plist =
    readPlist(join(mobileResourcesRoot, "MobileDevices-Info.plist")) ??
    readPlist(join(dirname(mobileResourcesRoot), "Info.plist"));
  const declarations = Array.isArray(plist?.UTExportedTypeDeclarations)
    ? plist.UTExportedTypeDeclarations
    : [];
  return declarations.flatMap((entry) => {
    const iconFile = typeof entry.UTTypeIconFile === "string" ? entry.UTTypeIconFile : "";
    const codes = entry.UTTypeTagSpecification?.["com.apple.device-model-code"];
    if (!iconFile.endsWith(".icns") || !Array.isArray(codes)) return [];
    const sourcePath = join(mobileResourcesRoot, iconFile);
    if (!existsSync(sourcePath)) return [];
    return [{
      description: entry.UTTypeDescription ?? "",
      iconFile,
      iconName: basename(iconFile, ".icns"),
      sourcePath,
      modelCodes: codes.filter((code) => typeof code === "string" && code.length > 0),
    }];
  });
}

function simulatorProfiles() {
  return readdirSync(deviceTypesRoot)
    .filter((entry) => entry.endsWith(".simdevicetype"))
    .map((entry) => {
      const name = basename(entry, ".simdevicetype");
      const profilePath = join(deviceTypesRoot, entry, "Contents", "Resources", "profile.plist");
      const profile = readPlist(profilePath);
      return { name, profilePath, profile };
    })
    .filter(({ name, profile }) =>
      profile && /^(iPhone|iPad|Apple Watch|Apple Vision Pro)/.test(name),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

function resolveIcon(profile, entries, deviceName) {
  const candidates = new Set();
  if (typeof profile.modelIdentifier === "string") candidates.add(profile.modelIdentifier);
  if (typeof profile.productClass === "string") {
    candidates.add(profile.productClass);
    candidates.add(`${profile.productClass}AP`);
  }
  const exact = entries.find((entry) => entry.modelCodes.some((code) => candidates.has(code)));
  if (exact) return { status: "exact", ...exact };

  const fallback = fallbackAssets.find((asset) => asset.pattern.test(deviceName));
  const sourcePath = fallback?.iconFiles.find((path) => existsSync(path));
  if (fallback && sourcePath) {
    return {
      status: "fallback",
      description: fallback.reason,
      iconFile: basename(sourcePath),
      iconName: fallback.name,
      sourcePath,
      modelCodes: [],
    };
  }
  return null;
}

function pngSize(png) {
  if (png.length < 24 || png[0] !== 0x89 || png.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("invalid PNG");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function alphaBounds(png) {
  const { width, height } = pngSize(png);
  let offset = 8;
  let bitDepth = 0;
  let colorType = 0;
  const idats = [];
  while (offset < png.length) {
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
  const bpp = colorType === 6 ? 4 : colorType === 4 ? 2 : 0;
  if (bitDepth !== 8 || bpp === 0 || idats.length === 0) return { x: 0, y: 0, width, height };

  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * bpp;
  let previous = Buffer.alloc(stride);
  let inputOffset = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const filter = raw[inputOffset++] ?? 0;
    const row = Buffer.from(raw.subarray(inputOffset, inputOffset + stride));
    inputOffset += stride;
    unfilter(row, previous, bpp, filter);
    for (let x = 0; x < width; x++) {
      const alpha = row[x * bpp + bpp - 1] ?? 0;
      if (alpha <= 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    previous = row;
  }
  return maxX < minX
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function unfilter(row, previous, bpp, filter) {
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bpp ? previous[i - bpp] : 0;
    if (filter === 1) row[i] = (row[i] + left) & 0xff;
    else if (filter === 2) row[i] = (row[i] + up) & 0xff;
    else if (filter === 3) row[i] = (row[i] + Math.floor((left + up) / 2)) & 0xff;
    else if (filter === 4) row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff;
    else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
  }
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

function renderCrop(iconName, sourcePath) {
  mkdirSync(outDir, { recursive: true });
  const rawPath = join(outDir, `${iconName}.raw.png`);
  const croppedPath = join(outDir, `${iconName}.png`);
  execFileSync("sips", ["-s", "format", "png", sourcePath, "--out", rawPath], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 10000,
  });
  const raw = readFileSync(rawPath);
  const bounds = alphaBounds(raw) ?? { x: 0, y: 0, ...pngSize(raw) };
  execFileSync(
    "sips",
    [
      "-c",
      String(bounds.height),
      String(bounds.width),
      "--cropOffset",
      String(bounds.y),
      String(bounds.x),
      "-s",
      "format",
      "png",
      sourcePath,
      "--out",
      croppedPath,
    ],
    { stdio: ["ignore", "ignore", "ignore"], timeout: 10000 },
  );
  rmSync(rawPath, { force: true });
  return { ...bounds, croppedPath };
}

const entries = coreTypesEntries();
if (render) rmSync(outDir, { recursive: true, force: true });
const rows = simulatorProfiles().map(({ name, profile }) => {
  const resolved = resolveIcon(profile, entries, name);
  if (!resolved) {
    return {
      device: name,
      modelIdentifier: profile.modelIdentifier ?? null,
      productClass: profile.productClass ?? null,
      status: "missing",
      iconName: null,
      iconFile: null,
      crop: null,
    };
  }
  const crop = render ? renderCrop(resolved.iconName, resolved.sourcePath) : null;
  return {
    device: name,
    modelIdentifier: profile.modelIdentifier ?? null,
    productClass: profile.productClass ?? null,
    status: resolved.status,
    iconName: resolved.iconName,
    iconFile: resolved.iconFile,
    crop: crop && {
      width: crop.width,
      height: crop.height,
      offsetX: crop.x,
      offsetY: crop.y,
      path: crop.croppedPath,
    },
    note: resolved.status === "fallback" ? resolved.description : undefined,
  };
});

if (json) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} else {
  for (const row of rows) {
    const crop = row.crop
      ? `${row.crop.width}x${row.crop.height}+${row.crop.offsetX},${row.crop.offsetY}`
      : "-";
    const note = row.note ? ` (${row.note})` : "";
    console.log(`${row.status.padEnd(8)} ${row.device.padEnd(36)} ${row.iconName ?? "-"} ${crop}${note}`);
  }
  if (render) {
    writeFileSync(join(outDir, "audit.json"), `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`\nWrote cropped PNGs and audit.json to ${outDir}`);
  }
}
