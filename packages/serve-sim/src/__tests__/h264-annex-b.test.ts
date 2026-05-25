import { describe, expect, test } from "bun:test";
import { H264AnnexBAccessUnitParser } from "../client/utils/h264-annex-b";

function collect(...chunks: number[][]) {
  const units: Array<{ data: number[]; type: "key" | "delta" }> = [];
  const parser = new H264AnnexBAccessUnitParser((unit) => {
    units.push({ data: [...unit.data], type: unit.type });
  });
  for (const chunk of chunks) parser.push(new Uint8Array(chunk));
  parser.flush();
  return units;
}

describe("H264AnnexBAccessUnitParser", () => {
  test("groups SPS, PPS, and IDR into a key access unit", () => {
    const units = collect([
      0, 0, 1, 0x67, 1,
      0, 0, 1, 0x68, 2,
      0, 0, 1, 0x65, 0x80,
    ]);

    expect(units).toEqual([
      {
        data: [0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 2, 0, 0, 1, 0x65, 0x80],
        type: "key",
      },
    ]);
  });

  test("splits consecutive frames across arbitrary chunks", () => {
    const units = collect(
      [0, 0],
      [1, 0x65, 0x80, 0, 0, 0],
      [1, 0x41, 0x80, 0, 0, 1, 0x41, 0x80],
    );

    expect(units).toEqual([
      { data: [0, 0, 1, 0x65, 0x80], type: "key" },
      { data: [0, 0, 0, 1, 0x41, 0x80], type: "delta" },
      { data: [0, 0, 1, 0x41, 0x80], type: "delta" },
    ]);
  });

  test("keeps multiple slices for one frame in the same access unit", () => {
    const units = collect([
      0, 0, 1, 0x41, 0x80,
      0, 0, 1, 0x41, 0x40,
      0, 0, 1, 0x41, 0x80,
    ]);

    expect(units).toEqual([
      {
        data: [0, 0, 1, 0x41, 0x80, 0, 0, 1, 0x41, 0x40],
        type: "delta",
      },
      { data: [0, 0, 1, 0x41, 0x80], type: "delta" },
    ]);
  });

  test("uses access unit delimiters as hard frame boundaries", () => {
    const units = collect([
      0, 0, 1, 0x09, 0xf0,
      0, 0, 1, 0x65, 0x80,
      0, 0, 1, 0x09, 0xf0,
      0, 0, 1, 0x41, 0x80,
    ]);

    expect(units).toEqual([
      { data: [0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x65, 0x80], type: "key" },
      { data: [0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x41, 0x80], type: "delta" },
    ]);
  });
});
