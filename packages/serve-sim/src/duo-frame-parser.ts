import type { DuoProjection } from "./duo-renderer";

/** Length-prefixed native frames; copy each byte once, regardless of pipe chunking. */
export function createDuoFrameParser(emit: (frame: { jpeg: Buffer; projection: DuoProjection }) => void) {
  let stage: "prefix" | "header" | "frame" = "prefix";
  const prefix = Buffer.allocUnsafe(4);
  let target = prefix;
  let offset = 0;
  let projection: DuoProjection;
  return {
    push(chunk: Buffer) {
      let start = 0;
      while (start < chunk.length) {
        const count = Math.min(chunk.length - start, target.length - offset);
        chunk.copy(target, offset, start, start + count);
        start += count;
        offset += count;
        if (offset !== target.length) continue;
        offset = 0;
        if (stage === "prefix") {
          const length = prefix.readUInt32BE(0);
          if (length < 1 || length > 65536) throw new Error("Invalid Duo render header");
          target = Buffer.allocUnsafe(length);
          stage = "header";
        } else if (stage === "header") {
          const { jpegLength, ...metadata } = JSON.parse(target.toString());
          if (!Number.isInteger(jpegLength) || jpegLength < 1 || jpegLength > 32_000_000) throw new Error("Invalid Duo render frame");
          projection = metadata;
          target = Buffer.allocUnsafe(jpegLength);
          stage = "frame";
        } else {
          const jpeg = target;
          target = prefix;
          stage = "prefix";
          emit({ jpeg, projection });
        }
      }
    },
  };
}
