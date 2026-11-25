import { describe, expect, test } from "bun:test";
import { encodeQr, renderQrHalfBlocks, type QrEcc } from "../install-qr";
import vectors from "./fixtures/qr-vectors.json";

// Reference matrices from python-qrcode 8.x (byte mode, its chosen version and
// mask, border 0). Each also decodes with zxing-cpp; see STATE.md for the
// generator script. Mask selection heuristics differ between encoders, so
// matrices are compared with the reference's mask forced.
interface Vector { text: string; ecc: QrEcc; version: number; mask: number; rows: string[] }

const toRows = (m: boolean[][]) => m.map((r) => r.map((b) => (b ? "1" : "0")).join(""));

/** Read the 15-bit format info (first copy) and check its BCH code. */
function formatInfo(m: boolean[][]): { ecc: number; mask: number } {
  let bits = 0;
  const at = (x: number, y: number) => (m[y]![x] ? 1 : 0);
  const order: [number, number][] = [];
  for (let i = 0; i <= 5; i++) order.push([8, i]);
  order.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) order.push([14 - i, 8]);
  order.forEach(([x, y], i) => { bits |= at(x, y) << i; });
  bits ^= 0x5412;
  const data = bits >>> 10;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  expect(((data << 10) | rem) & 0x7fff).toBe(bits);
  return { ecc: data >>> 3, mask: data & 7 };
}

describe("QR encoder", () => {
  for (const v of vectors as Vector[]) {
    test(`matches the reference matrix: v${v.version} ${v.ecc} mask ${v.mask} (${v.text.slice(0, 24)}…)`, () => {
      const qr = encodeQr(v.text, { ecc: v.ecc, mask: v.mask });
      expect(qr.version).toBe(v.version);
      expect(qr.size).toBe(v.version * 4 + 17);
      expect(toRows(qr.modules)).toEqual(v.rows);
    });
  }

  test("automatic mask writes consistent format info", () => {
    const FORMAT_ECC: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };
    for (const v of vectors as Vector[]) {
      const qr = encodeQr(v.text, { ecc: v.ecc });
      expect(qr.mask).toBeGreaterThanOrEqual(0);
      expect(qr.mask).toBeLessThan(8);
      expect(formatInfo(qr.modules)).toEqual({ ecc: FORMAT_ECC[v.ecc], mask: qr.mask });
    }
  });

  test("an install page URL fits a small version at ECC M", () => {
    const url = `https://lucky-otter-river-blue.trycloudflare.com/install/${"A".repeat(43)}/`;
    const qr = encodeQr(url, { ecc: "M" });
    expect(qr.version).toBeLessThanOrEqual(7);
  });

  test("rejects text that can't fit", () => {
    expect(() => encodeQr("x".repeat(3000), { ecc: "H" })).toThrow(/too long/);
  });
});

describe("half-block rendering", () => {
  test("two module rows per line with a 4-module quiet zone", () => {
    const qr = encodeQr("HELLO WORLD", { ecc: "L", mask: 3 });
    const lines = renderQrHalfBlocks(qr).split("\n");
    const n = qr.size + 8;
    expect(lines.length).toBe(Math.ceil(n / 2));
    for (const l of lines) expect([...l].length).toBe(n);
    expect(lines[0]).toBe(" ".repeat(n));
    expect(lines[1]).toBe(" ".repeat(n));
    // Line 2 = rows 4-5: the finder's dark top edge over its hollow second row.
    expect([...lines[2]!].slice(4, 11).join("")).toBe("█▀▀▀▀▀█");
    // Decode the characters back into modules.
    const back: boolean[][] = [];
    for (const l of lines) {
      const top: boolean[] = [];
      const bottom: boolean[] = [];
      for (const ch of l) {
        top.push(ch === "█" || ch === "▀");
        bottom.push(ch === "█" || ch === "▄");
      }
      back.push(top, bottom);
    }
    const inner = back.slice(4, 4 + qr.size).map((r) => r.slice(4, 4 + qr.size));
    expect(inner).toEqual(qr.modules);
  });

  test("color mode forces black on white", () => {
    const out = renderQrHalfBlocks(encodeQr("x"), { color: true });
    for (const l of out.split("\n")) {
      expect(l.startsWith("\x1b[30;107m")).toBe(true);
      expect(l.endsWith("\x1b[0m")).toBe(true);
    }
  });
});
