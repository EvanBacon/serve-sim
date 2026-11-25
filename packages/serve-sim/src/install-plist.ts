/**
 * Property list parsing for `serve-sim install`: XML plists and binary
 * plists (bplist00), the two formats an .ipa's Info.plist ships in, plus the
 * XML plist inside an embedded.mobileprovision. Pure JS, no plutil.
 */

export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Buffer
  | null
  | PlistValue[]
  | { [key: string]: PlistValue };

export type PlistDict = { [key: string]: PlistValue };

const MAX_DEPTH = 64;
const MAX_BINARY_OBJECTS = 1_000_000;

export function parsePlist(buf: Buffer): PlistValue {
  if (buf.length >= 8 && buf.toString("latin1", 0, 8) === "bplist00") return parseBinaryPlist(buf);
  return parseXmlPlist(buf.toString("utf8"));
}

// ---------------------------------------------------------------------------
// XML

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

class XmlCursor {
  pos = 0;
  constructor(readonly src: string) {}

  /** Skip whitespace, comments, the XML declaration and DOCTYPE. */
  skipMisc(): void {
    for (;;) {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
      if (this.src.startsWith("<!--", this.pos)) {
        const end = this.src.indexOf("-->", this.pos + 4);
        if (end < 0) throw new Error("Invalid plist: unterminated comment");
        this.pos = end + 3;
      } else if (this.src.startsWith("<?", this.pos) || this.src.startsWith("<!", this.pos)) {
        const end = this.src.indexOf(">", this.pos);
        if (end < 0) throw new Error("Invalid plist: unterminated declaration");
        this.pos = end + 1;
      } else {
        return;
      }
    }
  }

  tag(): Tag {
    this.skipMisc();
    if (this.src[this.pos] !== "<") throw new Error(`Invalid plist: expected a tag at offset ${this.pos}`);
    const end = this.src.indexOf(">", this.pos);
    if (end < 0) throw new Error("Invalid plist: unterminated tag");
    let body = this.src.slice(this.pos + 1, end).trim();
    this.pos = end + 1;
    const closing = body.startsWith("/");
    const selfClosing = body.endsWith("/");
    if (closing) body = body.slice(1);
    if (selfClosing) body = body.slice(0, -1);
    return { name: body.trim().split(/\s/)[0]!, closing, selfClosing };
  }

  peekClosing(): boolean {
    this.skipMisc();
    return this.src.startsWith("</", this.pos);
  }

  text(name: string): string {
    const close = `</${name}>`;
    const end = this.src.indexOf(close, this.pos);
    if (end < 0) throw new Error(`Invalid plist: unterminated <${name}>`);
    const raw = this.src.slice(this.pos, end);
    this.pos = end + close.length;
    return decodeEntities(raw);
  }

  expectClose(name: string): void {
    const t = this.tag();
    if (!t.closing || t.name !== name) throw new Error(`Invalid plist: expected </${name}>`);
  }
}

/** @lintignore Exported for tests. */
export function parseXmlPlist(xml: string): PlistValue {
  const cur = new XmlCursor(xml);
  const root = cur.tag();
  if (root.name !== "plist" || root.closing) throw new Error("Invalid plist: missing <plist>");
  if (root.selfClosing) return null;
  const value = readXmlValue(cur, cur.tag(), 0);
  cur.expectClose("plist");
  return value;
}

function readXmlValue(cur: XmlCursor, t: Tag, depth: number): PlistValue {
  if (depth > MAX_DEPTH) throw new Error("Invalid plist: nested too deeply");
  if (t.closing) throw new Error(`Invalid plist: unexpected </${t.name}>`);
  switch (t.name) {
    case "dict": {
      const out: PlistDict = Object.create(null);
      if (t.selfClosing) return out;
      while (!cur.peekClosing()) {
        const k = cur.tag();
        if (k.name !== "key") throw new Error(`Invalid plist: expected <key>, got <${k.name}>`);
        const key = k.selfClosing ? "" : cur.text("key");
        out[key] = readXmlValue(cur, cur.tag(), depth + 1);
      }
      cur.expectClose("dict");
      return out;
    }
    case "array": {
      const out: PlistValue[] = [];
      if (t.selfClosing) return out;
      while (!cur.peekClosing()) out.push(readXmlValue(cur, cur.tag(), depth + 1));
      cur.expectClose("array");
      return out;
    }
    case "true":
    case "false":
      if (!t.selfClosing) cur.expectClose(t.name);
      return t.name === "true";
    case "string":
      return t.selfClosing ? "" : cur.text("string");
    case "integer": {
      const raw = t.selfClosing ? "0" : cur.text("integer").trim();
      const n = Number(raw);
      return Number.isSafeInteger(n) ? n : BigInt(raw);
    }
    case "real":
      return t.selfClosing ? 0 : Number(cur.text("real").trim());
    case "date":
      return new Date(t.selfClosing ? 0 : cur.text("date").trim());
    case "data":
      return Buffer.from(t.selfClosing ? "" : cur.text("data").replace(/\s+/g, ""), "base64");
    default:
      throw new Error(`Invalid plist: unknown element <${t.name}>`);
  }
}

// ---------------------------------------------------------------------------
// Binary (bplist00)

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/** @lintignore Exported for tests. */
export function parseBinaryPlist(buf: Buffer): PlistValue {
  if (buf.length < 40 || buf.toString("latin1", 0, 8) !== "bplist00") throw new Error("Not a binary plist");
  const trailer = buf.length - 32;
  const offsetSize = buf[trailer + 6]!;
  const refSize = buf[trailer + 7]!;
  const numObjects = Number(buf.readBigUInt64BE(trailer + 8));
  const topObject = Number(buf.readBigUInt64BE(trailer + 16));
  const tableOffset = Number(buf.readBigUInt64BE(trailer + 24));
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) throw new Error("Invalid binary plist trailer");
  if (tableOffset + numObjects * offsetSize > trailer || topObject >= numObjects) throw new Error("Invalid binary plist offsets");

  const uint = (at: number, size: number): number => {
    if (at < 0 || at + size > buf.length) throw new Error("Invalid binary plist: read out of range");
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[at + i]!;
    if (!Number.isSafeInteger(v)) throw new Error("Invalid binary plist: integer out of range");
    return v;
  };
  const offsetOf = (ref: number): number => {
    if (ref >= numObjects) throw new Error("Invalid binary plist: bad object reference");
    return uint(tableOffset + ref * offsetSize, offsetSize);
  };

  const active = new Set<number>();
  // Shared references aren't cycles but can still expand exponentially.
  let budget = MAX_BINARY_OBJECTS;
  const readObject = (ref: number, depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw new Error("Invalid binary plist: nested too deeply");
    if (--budget < 0) throw new Error("Invalid binary plist: too many objects");
    if (active.has(ref)) throw new Error("Invalid binary plist: reference cycle");
    active.add(ref);
    try {
      return readAt(offsetOf(ref), depth);
    } finally {
      active.delete(ref);
    }
  };

  // Length of a container/string/data: low nibble, or 0xF then an int object.
  const lengthAt = (at: number): { length: number; start: number } => {
    const low = buf[at]! & 0x0f;
    if (low !== 0x0f) return { length: low, start: at + 1 };
    const marker = buf[at + 1]!;
    if (marker >> 4 !== 0x1) throw new Error("Invalid binary plist: bad length");
    const size = 1 << (marker & 0x0f);
    return { length: uint(at + 2, size), start: at + 2 + size };
  };

  const readAt = (at: number, depth: number): PlistValue => {
    if (at >= trailer) throw new Error("Invalid binary plist: object out of range");
    const marker = buf[at]!;
    const type = marker >> 4;
    const low = marker & 0x0f;
    switch (type) {
      case 0x0:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        return null;
      case 0x1: {
        const size = 1 << low;
        if (size === 8) {
          const v = buf.readBigInt64BE(at + 1);
          return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        }
        if (size === 16) {
          // 128-bit: only values that fit in 64 bits (CF writes unsigned 64-bit ints this way).
          const v = (buf.readBigInt64BE(at + 1) << 64n) | buf.readBigUInt64BE(at + 9);
          if (v < -(1n << 63n) || v >= 1n << 64n) throw new Error("Invalid binary plist: unsupported 128-bit integer");
          return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        }
        return uint(at + 1, size);
      }
      case 0x2:
        if (low === 2) return buf.readFloatBE(at + 1);
        if (low === 3) return buf.readDoubleBE(at + 1);
        throw new Error(`Invalid binary plist: unsupported real size ${1 << low}`);
      case 0x3:
        return new Date(APPLE_EPOCH_MS + buf.readDoubleBE(at + 1) * 1000);
      case 0x4: {
        const { length, start } = lengthAt(at);
        if (start + length > trailer) throw new Error("Invalid binary plist: data out of range");
        return Buffer.from(buf.subarray(start, start + length));
      }
      case 0x5: {
        const { length, start } = lengthAt(at);
        if (start + length > trailer) throw new Error("Invalid binary plist: string out of range");
        return buf.toString("latin1", start, start + length);
      }
      case 0x6: {
        const { length, start } = lengthAt(at);
        if (start + length * 2 > trailer) throw new Error("Invalid binary plist: string out of range");
        const units = Buffer.from(buf.subarray(start, start + length * 2));
        units.swap16();
        return units.toString("utf16le");
      }
      case 0x8:
        return uint(at + 1, low + 1);
      case 0xa: {
        const { length, start } = lengthAt(at);
        const out: PlistValue[] = [];
        for (let i = 0; i < length; i++) out.push(readObject(uint(start + i * refSize, refSize), depth + 1));
        return out;
      }
      case 0xd: {
        const { length, start } = lengthAt(at);
        const out: PlistDict = Object.create(null);
        for (let i = 0; i < length; i++) {
          const key = readObject(uint(start + i * refSize, refSize), depth + 1);
          if (typeof key !== "string") throw new Error("Invalid binary plist: non-string dictionary key");
          out[key] = readObject(uint(start + (length + i) * refSize, refSize), depth + 1);
        }
        return out;
      }
      default:
        throw new Error(`Invalid binary plist: unsupported object type 0x${marker.toString(16)}`);
    }
  };

  return readObject(topObject, 0);
}

/**
 * The XML plist inside an embedded.mobileprovision. The file is a CMS
 * (PKCS#7) signed blob whose content is a plain XML plist, so slicing
 * between `<?xml` and `</plist>` is enough; the signature isn't verified.
 */
export function extractProvisionPlist(blob: Buffer): PlistDict {
  const text = blob.toString("latin1");
  const start = text.indexOf("<?xml");
  const end = text.indexOf("</plist>", start);
  if (start < 0 || end < 0) throw new Error("embedded.mobileprovision has no plist");
  const xml = blob.subarray(start, end + "</plist>".length).toString("utf8");
  const value = parseXmlPlist(xml);
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date || Buffer.isBuffer(value)) {
    throw new Error("embedded.mobileprovision plist is not a dictionary");
  }
  return value as PlistDict;
}
