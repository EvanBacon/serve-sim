export interface H264AccessUnit {
  data: Uint8Array<ArrayBufferLike>;
  type: "key" | "delta";
}

interface NalUnit {
  bytes: Uint8Array<ArrayBufferLike>;
  type: number;
  isVcl: boolean;
  firstMbInSlice: number | null;
}

function concatBytes(parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBufferLike> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function startCodeLength(bytes: Uint8Array<ArrayBufferLike>, offset: number): number {
  if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) return 0;
  if (bytes[offset + 2] === 1) return 3;
  if (bytes[offset + 2] === 0 && bytes[offset + 3] === 1) return 4;
  return 0;
}

function findStartCode(
  bytes: Uint8Array<ArrayBufferLike>,
  from: number,
): { index: number; length: number } | null {
  for (let i = Math.max(0, from); i <= bytes.length - 3; i++) {
    const length = startCodeLength(bytes, i);
    if (length) return { index: i, length };
  }
  return null;
}

function nalHeaderOffset(bytes: Uint8Array<ArrayBufferLike>): number {
  const length = startCodeLength(bytes, 0);
  return length ? length : 0;
}

function nalType(bytes: Uint8Array<ArrayBufferLike>): number {
  const offset = nalHeaderOffset(bytes);
  return offset < bytes.length ? bytes[offset]! & 0x1f : 0;
}

function rbspFromNal(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const headerOffset = nalHeaderOffset(bytes);
  const escaped = bytes.slice(headerOffset + 1);
  const out: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    if (i >= 2 && escaped[i] === 0x03 && escaped[i - 1] === 0x00 && escaped[i - 2] === 0x00) {
      continue;
    }
    out.push(escaped[i]!);
  }
  return new Uint8Array(out);
}

class BitReader {
  private bitOffset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readBit(): number | null {
    if (this.bitOffset >= this.bytes.length * 8) return null;
    const byte = this.bytes[this.bitOffset >> 3]!;
    const bit = (byte >> (7 - (this.bitOffset & 7))) & 1;
    this.bitOffset++;
    return bit;
  }

  readBits(count: number): number | null {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const bit = this.readBit();
      if (bit == null) return null;
      value = (value << 1) | bit;
    }
    return value;
  }

  readUnsignedExpGolomb(): number | null {
    let leadingZeroes = 0;
    while (true) {
      const bit = this.readBit();
      if (bit == null) return null;
      if (bit === 1) break;
      leadingZeroes++;
      if (leadingZeroes > 31) return null;
    }
    const suffix = leadingZeroes === 0 ? 0 : this.readBits(leadingZeroes);
    if (suffix == null) return null;
    return (1 << leadingZeroes) - 1 + suffix;
  }
}

function firstMbInSlice(bytes: Uint8Array<ArrayBufferLike>): number | null {
  const type = nalType(bytes);
  if (type !== 1 && type !== 5) return null;
  return new BitReader(rbspFromNal(bytes)).readUnsignedExpGolomb();
}

function makeNalUnit(bytes: Uint8Array<ArrayBufferLike>): NalUnit {
  const type = nalType(bytes);
  return {
    bytes,
    type,
    isVcl: type >= 1 && type <= 5,
    firstMbInSlice: firstMbInSlice(bytes),
  };
}

export class H264AnnexBAccessUnitParser {
  private pendingBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private pendingNals: NalUnit[] = [];
  private readonly onAccessUnit: (accessUnit: H264AccessUnit) => void;

  constructor(onAccessUnit: (accessUnit: H264AccessUnit) => void) {
    this.onAccessUnit = onAccessUnit;
  }

  push(chunk: Uint8Array<ArrayBufferLike>): void {
    this.pendingBytes = concatBytes([this.pendingBytes, chunk]);
    for (const unit of this.extractCompleteNals(false)) {
      this.pushNal(makeNalUnit(unit));
    }
  }

  flush(): void {
    for (const unit of this.extractCompleteNals(true)) {
      this.pushNal(makeNalUnit(unit));
    }
    this.flushAccessUnit();
  }

  private extractCompleteNals(flush: boolean): Uint8Array<ArrayBufferLike>[] {
    const out: Uint8Array<ArrayBufferLike>[] = [];
    let first = findStartCode(this.pendingBytes, 0);
    if (!first) {
      this.pendingBytes = this.pendingBytes.slice(Math.max(0, this.pendingBytes.length - 3));
      return out;
    }

    if (first.index > 0) {
      this.pendingBytes = this.pendingBytes.slice(first.index);
      first = { index: 0, length: first.length };
    }

    let searchFrom = first.index + first.length;
    while (true) {
      const next = findStartCode(this.pendingBytes, searchFrom);
      if (!next) break;
      out.push(this.pendingBytes.slice(first.index, next.index));
      first = next;
      searchFrom = next.index + next.length;
    }

    if (flush && this.pendingBytes.length > first.index + first.length) {
      out.push(this.pendingBytes.slice(first.index));
      this.pendingBytes = new Uint8Array(0);
    } else {
      this.pendingBytes = this.pendingBytes.slice(first.index);
    }
    return out;
  }

  private pushNal(nal: NalUnit): void {
    if (nal.type === 9) {
      this.flushAccessUnit();
      this.pendingNals.push(nal);
      return;
    }

    const hasVcl = this.pendingNals.some((unit) => unit.isVcl);
    if (nal.isVcl && hasVcl && (nal.firstMbInSlice === null || nal.firstMbInSlice === 0)) {
      this.flushAccessUnit();
    }

    this.pendingNals.push(nal);
  }

  private flushAccessUnit(): void {
    if (!this.pendingNals.some((unit) => unit.isVcl)) {
      this.pendingNals = [];
      return;
    }
    this.onAccessUnit({
      data: concatBytes(this.pendingNals.map((unit) => unit.bytes)),
      type: this.pendingNals.some((unit) => unit.type === 5) ? "key" : "delta",
    });
    this.pendingNals = [];
  }
}
