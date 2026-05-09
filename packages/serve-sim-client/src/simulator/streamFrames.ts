export interface ExtractedImageFrame {
  frame: Uint8Array;
  rest: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function extractImageFrame(buffer: Uint8Array): ExtractedImageFrame | null {
  const jpegStart = findJpegStart(buffer);
  const pngStart = findPngSignature(buffer);
  if (jpegStart === -1 && pngStart === -1) return null;
  if (pngStart !== -1 && (jpegStart === -1 || pngStart < jpegStart)) {
    return extractPngFrame(buffer, pngStart);
  }
  return extractJpegFrame(buffer, jpegStart);
}

function findJpegStart(buffer: Uint8Array): number {
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd8) {
      return i;
    }
  }
  return -1;
}

function extractJpegFrame(buffer: Uint8Array, start: number): ExtractedImageFrame | null {
  if (start === -1) return null;
  for (let i = start + 2; i < buffer.length - 1; i++) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) {
      const end = i + 2;
      return {
        frame: buffer.slice(start, end),
        rest: buffer.slice(end),
        mimeType: "image/jpeg",
      };
    }
  }
  return null;
}

function extractPngFrame(buffer: Uint8Array, start: number): ExtractedImageFrame | null {
  if (start === -1) return null;

  let offset = start + PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = readUInt32BE(buffer, offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + length + 4;
    if (chunkEnd > buffer.length) return null;
    const type =
      String.fromCharCode(buffer[typeOffset] ?? 0) +
      String.fromCharCode(buffer[typeOffset + 1] ?? 0) +
      String.fromCharCode(buffer[typeOffset + 2] ?? 0) +
      String.fromCharCode(buffer[typeOffset + 3] ?? 0);
    if (type === "IEND") {
      return {
        frame: buffer.slice(start, chunkEnd),
        rest: buffer.slice(chunkEnd),
        mimeType: "image/png",
      };
    }
    offset = chunkEnd;
  }

  return null;
}

function findPngSignature(buffer: Uint8Array): number {
  outer:
  for (let i = 0; i <= buffer.length - PNG_SIGNATURE.length; i++) {
    for (let j = 0; j < PNG_SIGNATURE.length; j++) {
      if (buffer[i + j] !== PNG_SIGNATURE[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function readUInt32BE(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset] ?? 0) * 0x1000000) +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  );
}
