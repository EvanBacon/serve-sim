/**
 * Minimal read-only ZIP reader for `serve-sim install` (inspecting an .ipa).
 *
 * Pure Node (node:fs + node:zlib) so it runs on Linux CI. It reads the
 * central directory, then inflates only the entries asked for, each with a
 * hard cap on the inflated size (a zip bomb can't blow up memory). Supports
 * stored and deflated entries and ZIP64 sizes/offsets. Nothing is ever
 * extracted to disk, so entry names can't escape anywhere.
 */
import { closeSync, fstatSync, openSync, readSync } from "fs";
import { inflateRawSync } from "zlib";

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** Central directories bigger than this are not an app bundle. */
const MAX_CENTRAL_DIRECTORY = 256 * 1024 * 1024;

function u64(buf: Buffer, offset: number): number {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ZIP64 value out of range");
  return Number(value);
}

export class ZipReader {
  readonly entries: ZipEntry[];
  private readonly byName = new Map<string, ZipEntry>();

  private constructor(private readonly fd: number, private readonly fileSize: number) {
    this.entries = this.readCentralDirectory();
    for (const entry of this.entries) {
      if (!this.byName.has(entry.name)) this.byName.set(entry.name, entry);
    }
  }

  static open(path: string): ZipReader {
    const fd = openSync(path, "r");
    try {
      return new ZipReader(fd, fstatSync(fd).size);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  close(): void {
    try { closeSync(this.fd); } catch {}
  }

  get(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  private read(offset: number, length: number): Buffer {
    if (offset < 0 || length < 0 || offset + length > this.fileSize) {
      throw new Error("Corrupt zip: read past end of file");
    }
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = readSync(this.fd, buf, done, length - done, offset + done);
      if (n <= 0) throw new Error("Corrupt zip: unexpected end of file");
      done += n;
    }
    return buf;
  }

  private readCentralDirectory(): ZipEntry[] {
    // EOCD is 22 bytes plus a comment of up to 65535 bytes at the very end.
    const tailLength = Math.min(this.fileSize, 22 + 0xffff);
    if (tailLength < 22) throw new Error("Not a zip file (too small)");
    const tailStart = this.fileSize - tailLength;
    const tail = this.read(tailStart, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a zip file (no end of central directory)");

    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locatorAt = tailStart + eocd - 20;
      if (locatorAt < 0) throw new Error("Corrupt zip: missing ZIP64 locator");
      const locator = this.read(locatorAt, 20);
      if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) throw new Error("Corrupt zip: missing ZIP64 locator");
      const z64At = u64(locator, 8);
      const z64 = this.read(z64At, 56);
      if (z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error("Corrupt zip: bad ZIP64 end of central directory");
      count = u64(z64, 32);
      cdSize = u64(z64, 40);
      cdOffset = u64(z64, 48);
    }
    if (cdSize > MAX_CENTRAL_DIRECTORY) throw new Error("Zip central directory is too large");

    const cd = this.read(cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG) throw new Error("Corrupt zip: bad central directory entry");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const end = p + 46 + nameLength + extraLength + commentLength;
      if (end > cd.length) throw new Error("Corrupt zip: truncated central directory");
      const name = cd.toString("utf8", p + 46, p + 46 + nameLength);

      // ZIP64 extended info: only the fields that overflowed are present, in this order.
      if (size === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        let e = p + 46 + nameLength;
        const extraEnd = e + extraLength;
        while (e + 4 <= extraEnd) {
          const id = cd.readUInt16LE(e);
          const len = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            const fieldEnd = Math.min(q + len, extraEnd);
            if (size === 0xffffffff && q + 8 <= fieldEnd) { size = u64(cd, q); q += 8; }
            if (compressedSize === 0xffffffff && q + 8 <= fieldEnd) { compressedSize = u64(cd, q); q += 8; }
            if (localHeaderOffset === 0xffffffff && q + 8 <= fieldEnd) { localHeaderOffset = u64(cd, q); }
            break;
          }
          e += 4 + len;
        }
      }
      entries.push({ name, method, flags, compressedSize, size, localHeaderOffset });
      p = end;
    }
    return entries;
  }

  /**
   * Inflate one entry. Throws if it would exceed `maxSize` bytes, is
   * encrypted, or uses a method other than store/deflate.
   */
  readEntry(entry: ZipEntry, maxSize: number): Buffer {
    if (entry.flags & 0x1) throw new Error(`${entry.name} is encrypted`);
    if (entry.size > maxSize) throw new Error(`${entry.name} is too large (${entry.size} bytes, limit ${maxSize})`);
    const local = this.read(entry.localHeaderOffset, 30);
    if (local.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`Corrupt zip: bad local header for ${entry.name}`);
    const dataStart = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw new Error(`Corrupt zip: stored size mismatch for ${entry.name}`);
      return this.read(dataStart, entry.size);
    }
    if (entry.method === 8) {
      // Deflate can't expand more than ~1032:1; refuse silly ratios up front.
      if (entry.compressedSize > maxSize * 2 + 1024) throw new Error(`${entry.name} is too large`);
      const compressed = this.read(dataStart, entry.compressedSize);
      let out: Buffer;
      try {
        out = inflateRawSync(compressed, { maxOutputLength: maxSize });
      } catch (error) {
        throw new Error(`Could not inflate ${entry.name}: ${(error as Error).message}`);
      }
      if (out.length !== entry.size) throw new Error(`Corrupt zip: size mismatch for ${entry.name}`);
      return out;
    }
    throw new Error(`${entry.name} uses unsupported zip compression method ${entry.method}`);
  }
}
