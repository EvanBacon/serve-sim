import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ZipReader } from "../install-zip";
import { makeZip } from "./install-fixtures";

const dir = mkdtempSync(join(tmpdir(), "install-zip-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function write(buf: Buffer): string {
  const p = join(dir, `t${n++}.zip`);
  writeFileSync(p, buf);
  return p;
}

const text = "hello ".repeat(500);

describe("ZipReader", () => {
  for (const zip64 of [false, true]) {
    test(`reads stored and deflated entries${zip64 ? " (ZIP64 records)" : ""}`, () => {
      const path = write(makeZip([
        { name: "stored.txt", data: "plain bytes", store: true },
        { name: "dir/deflated.txt", data: text },
        { name: "empty", data: "", store: true },
      ], { zip64 }));
      const zip = ZipReader.open(path);
      try {
        expect(zip.entries.map((e) => e.name)).toEqual(["stored.txt", "dir/deflated.txt", "empty"]);
        expect(zip.get("stored.txt")!.method).toBe(0);
        expect(zip.get("dir/deflated.txt")!.method).toBe(8);
        expect(zip.get("dir/deflated.txt")!.compressedSize).toBeLessThan(text.length);
        expect(zip.readEntry(zip.get("stored.txt")!, 1024).toString()).toBe("plain bytes");
        expect(zip.readEntry(zip.get("dir/deflated.txt")!, 1 << 20).toString()).toBe(text);
        expect(zip.readEntry(zip.get("empty")!, 10).length).toBe(0);
      } finally {
        zip.close();
      }
    });
  }

  test("handles an archive comment after the EOCD", () => {
    const zip = makeZip([{ name: "a", data: "x", store: true }]);
    zip.writeUInt16LE(5, zip.length - 2);
    const path = write(Buffer.concat([zip, Buffer.from("hello")]));
    const r = ZipReader.open(path);
    expect(r.readEntry(r.get("a")!, 10).toString()).toBe("x");
    r.close();
  });

  test("caps the inflated size (zip bomb)", () => {
    const bomb = Buffer.alloc(4 * 1024 * 1024); // deflates to a few KB
    const path = write(makeZip([{ name: "bomb", data: bomb }]));
    const zip = ZipReader.open(path);
    expect(zip.get("bomb")!.compressedSize).toBeLessThan(10_000);
    expect(() => zip.readEntry(zip.get("bomb")!, 1024 * 1024)).toThrow(/too large/);
    // A lying central directory size still can't inflate past the cap.
    const lying = { ...zip.get("bomb")!, size: 1000 };
    expect(() => zip.readEntry(lying, 1024 * 1024)).toThrow();
    zip.close();
  });

  test("rejects non-zips, encrypted entries and unknown methods", () => {
    expect(() => ZipReader.open(write(Buffer.from("not a zip at all, definitely not")))).toThrow(/Not a zip/);
    const zip = ZipReader.open(write(makeZip([{ name: "a", data: "x", store: true }])));
    expect(() => zip.readEntry({ ...zip.get("a")!, flags: 1 }, 10)).toThrow(/encrypted/);
    expect(() => zip.readEntry({ ...zip.get("a")!, method: 12 }, 10)).toThrow(/unsupported/);
    zip.close();
  });

  test("rejects offsets outside the file", () => {
    const zip = ZipReader.open(write(makeZip([{ name: "a", data: "x", store: true }])));
    expect(() => zip.readEntry({ ...zip.get("a")!, localHeaderOffset: 1 << 30 }, 10)).toThrow(/past end/);
    zip.close();
  });
});
