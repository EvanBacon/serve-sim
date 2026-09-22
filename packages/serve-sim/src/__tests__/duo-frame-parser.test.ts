import { expect, test } from "bun:test";
import { createDuoFrameParser } from "../duo-frame-parser";

const projection = { width: 1500, height: 1350, panel: "inner" as const, hingeDegrees: 130, pieces: [] };
function wire(body: Buffer, size = body.length) {
  const header = Buffer.from(JSON.stringify({ ...projection, jpegLength: size }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
  return Buffer.concat([prefix, header, body]);
}
test("reassembles fragmented headers and large frames, preserving previous frames", () => {
  const frames: Buffer[] = [];
  const parser = createDuoFrameParser((frame) => { expect(frame.projection).toEqual(projection); frames.push(frame.jpeg); });
  const bodies = [Buffer.alloc(1_000_000, 17), Buffer.alloc(200_000, 23)];
  const input = Buffer.concat(bodies.map((body) => wire(body)));
  for (let start = 0; start < input.length;) {
    const length = start < 256 ? 1 : 16384;
    parser.push(input.subarray(start, start + length)); start += length;
  }
  expect(frames).toEqual(bodies);
});
test("parses multiple complete frames from one read", () => {
  const frames: Buffer[] = [];
  createDuoFrameParser((frame) => frames.push(frame.jpeg)).push(Buffer.concat([wire(Buffer.from([1])), wire(Buffer.from([2]))]));
  expect(frames).toEqual([Buffer.from([1]), Buffer.from([2])]);
});
test("rejects invalid lengths before allocating a frame", () => {
  for (const length of [0, -1, 32_000_001, 1.5]) {
    expect(() => createDuoFrameParser(() => {}).push(wire(Buffer.alloc(0), length))).toThrow("Invalid Duo render frame");
  }
  expect(() => createDuoFrameParser(() => {}).push(Buffer.alloc(4))).toThrow("Invalid Duo render header");
});
