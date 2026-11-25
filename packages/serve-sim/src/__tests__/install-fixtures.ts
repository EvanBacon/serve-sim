/** Test helpers for `serve-sim install`: build zips, ipas and provisioning profiles in memory. */
import { deflateRawSync } from "zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipInput {
  name: string;
  data: Buffer | string;
  /** Default: deflate. */
  store?: boolean;
}

/** Minimal zip writer. `zip64` forces ZIP64 records everywhere (sizes, offsets, EOCD). */
export function makeZip(files: ZipInput[], opts: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const method = f.store ? 0 : 8;
    const body = f.store ? data : deflateRawSync(data);
    const name = Buffer.from(f.name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(opts.zip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    let extra = Buffer.alloc(0);
    if (opts.zip64) {
      extra = Buffer.alloc(28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(opts.zip64 ? 45 : 20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(opts.zip64 ? 0xffffffff : body.length, 20);
    central.writeUInt32LE(opts.zip64 ? 0xffffffff : data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(opts.zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, name, extra);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const tail: Buffer[] = [];
  if (opts.zip64) {
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(BigInt(files.length), 24);
    z64.writeBigUInt64LE(BigInt(files.length), 32);
    z64.writeBigUInt64LE(BigInt(cd.length), 40);
    z64.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(z64, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : files.length, 8);
  eocd.writeUInt16LE(opts.zip64 ? 0xffff : files.length, 10);
  eocd.writeUInt32LE(opts.zip64 ? 0xffffffff : cd.length, 12);
  eocd.writeUInt32LE(opts.zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, cd, ...tail, eocd]);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Xml = string | number | boolean | Date | Xml[] | { [k: string]: Xml };

/** Tiny XML plist writer for fixtures. */
export function xmlPlist(value: Xml): string {
  const enc = (v: Xml): string => {
    if (typeof v === "string") return `<string>${esc(v)}</string>`;
    if (typeof v === "number") return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
    if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
    if (v instanceof Date) return `<date>${v.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`;
    if (Array.isArray(v)) return `<array>${v.map(enc).join("")}</array>`;
    return `<dict>${Object.entries(v).map(([k, x]) => `<key>${esc(k)}</key>${enc(x)}`).join("")}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${enc(value)}\n</plist>\n`;
}

export interface ProfileFixture {
  appId?: string;
  getTaskAllow?: boolean;
  devices?: string[];
  allDevices?: boolean;
  expires?: Date;
}

/** A fake embedded.mobileprovision: DER-ish bytes around an XML plist, like CMS. */
export function mobileprovision(p: ProfileFixture = {}): Buffer {
  const dict: Record<string, Xml> = {
    AppIDName: "Test",
    ApplicationIdentifierPrefix: ["ABCDE12345"],
    CreationDate: new Date("2026-01-01T00:00:00Z"),
    Entitlements: {
      "application-identifier": p.appId ?? "ABCDE12345.com.example.app",
      "com.apple.developer.team-identifier": "ABCDE12345",
      "get-task-allow": p.getTaskAllow ?? false,
    },
    ExpirationDate: p.expires ?? new Date("2027-01-01T00:00:00Z"),
    Name: "Test Profile",
    TeamIdentifier: ["ABCDE12345"],
    TeamName: "Example Team",
    UUID: "11111111-2222-3333-4444-555555555555",
    Version: 1,
  };
  if (p.devices) dict.ProvisionedDevices = p.devices;
  if (p.allDevices) dict.ProvisionsAllDevices = true;
  return Buffer.concat([
    Buffer.from([0x30, 0x82, 0x1d, 0x4f, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02, 0xa0]),
    Buffer.from(xmlPlist(dict)),
    Buffer.from([0x00, 0xa0, 0x82, 0x0d, 0x3e, 0x30, 0x82, 0x04]),
  ]);
}

/** PNG signature + a first chunk header (no valid image data; enough for type sniffing). */
export function fakePng(cgbi = false, size = 64): Buffer {
  const chunk = (type: string, len: number) => {
    const b = Buffer.alloc(8 + len + 4);
    b.writeUInt32BE(len, 0);
    b.write(type, 4, "latin1");
    return b;
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...(cgbi ? [chunk("CgBI", 4)] : []),
    chunk("IHDR", 13),
    Buffer.alloc(size),
  ]);
}

export interface IpaFixture {
  info?: Buffer | string;
  profile?: Buffer | null;
  codeResources?: boolean;
  extra?: ZipInput[];
  appName?: string;
}

export function makeIpa(f: IpaFixture = {}): Buffer {
  const app = `Payload/${f.appName ?? "Example"}.app/`;
  const files: ZipInput[] = [
    { name: `${app}Info.plist`, data: f.info ?? xmlPlist({ CFBundleIdentifier: "com.example.app", CFBundleName: "Example", CFBundleShortVersionString: "1.0", CFBundleVersion: "1" }) },
    { name: `${app}Example`, data: Buffer.alloc(2048, 7), store: true },
  ];
  if (f.profile !== null) files.push({ name: `${app}embedded.mobileprovision`, data: f.profile ?? mobileprovision({ devices: ["00008101-001A2B3C4D5E6F70"] }) });
  if (f.codeResources !== false) files.push({ name: `${app}_CodeSignature/CodeResources`, data: xmlPlist({ files: {} }) });
  for (const e of f.extra ?? []) files.push({ ...e, name: e.name.startsWith("Payload/") ? e.name : `${app}${e.name}` });
  return makeZip(files);
}
