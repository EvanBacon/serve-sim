import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer, type Server } from "http";
import { connect } from "net";
import { tmpdir } from "os";
import { join } from "path";
import {
  InstallServer,
  PAGE_CSP,
  buildInstallPage,
  buildManifest,
  generateCapability,
  installUrls,
  itmsServicesUrl,
  parseRange,
  strictTargetPath,
  xmlEscape,
  type InstallServerOptions,
} from "../install-server";
import { parseXmlPlist } from "../install-plist";
import { fakePng } from "./install-fixtures";

const ORIGIN = "https://lucky-otter-river-blue.trycloudflare.com";
const dir = mkdtempSync(join(tmpdir(), "install-server-test-"));
const ipaPath = join(dir, "app.ipa");
const ipaBytes = Buffer.from(Array.from({ length: 100_000 }, (_, i) => (i * 31) % 251));
writeFileSync(ipaPath, ipaBytes);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

let server: Server | undefined;
let port = 0;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function start(extra: Partial<InstallServerOptions> = {}, activate = true) {
  const cap = generateCapability();
  const install = new InstallServer({
    cap,
    ipaPath,
    ipaSize: ipaBytes.length,
    appName: "OTA <Test> & \"Co\"",
    bundleId: "com.example.app",
    version: "1.0",
    build: "7",
    ...extra,
  });
  if (activate) install.activate(ORIGIN, (extra.now ?? Date.now)() + 60_000);
  server = createServer(install.handle);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  return { cap, install };
}

/**
 * One request over a raw socket, so the target reaches the server byte for
 * byte. `http.request` can't be used: bun 1.3's client normalises `/a/../b`
 * and `%2e` in `path` before sending.
 */
function get(path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const head = [`${opts.method ?? "GET"} ${path} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close"];
    for (const [k, v] of Object.entries(opts.headers ?? {})) head.push(`${k}: ${v}`);
    const chunks: Buffer[] = [];
    const sock = connect(port, "127.0.0.1", () => sock.write(`${head.join("\r\n")}\r\n\r\n`));
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("error", reject);
    sock.on("close", () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) return reject(new Error(`No HTTP response for ${path}`));
      const [statusLine, ...lines] = raw.subarray(0, split).toString("latin1").split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const i = line.indexOf(":");
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        headers[k] = headers[k] === undefined ? v : `${headers[k]}, ${v}`;
      }
      resolve({ status: Number(statusLine!.split(" ")[1]), headers, body: raw.subarray(split + 4) });
    });
  });
}

function expectSecurityHeaders(res: Res) {
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["referrer-policy"]).toBe("no-referrer");
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(String(res.headers["x-robots-tag"])).toContain("noindex");
}

describe("capability", () => {
  test("32 random bytes, base64url", () => {
    const a = generateCapability();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCapability()).not.toBe(a);
  });
});

describe("manifest and links", () => {
  test("itms-services link url-encodes the manifest URL", () => {
    const manifest = `${ORIGIN}/install/abc_-123/manifest.plist`;
    const link = itmsServicesUrl(manifest);
    expect(link).toBe(
      "itms-services://?action=download-manifest&url=https%3A%2F%2Flucky-otter-river-blue.trycloudflare.com%2Finstall%2Fabc_-123%2Fmanifest.plist",
    );
    expect(new URLSearchParams(link.slice(link.indexOf("?") + 1)).get("url")).toBe(manifest);
  });

  test("installUrls are absolute https URLs under /install/<cap>/", () => {
    const u = installUrls(ORIGIN, "CAP", true);
    expect(u).toEqual({
      page: `${ORIGIN}/install/CAP/`,
      manifest: `${ORIGIN}/install/CAP/manifest.plist`,
      ipa: `${ORIGIN}/install/CAP/app.ipa`,
      icon: `${ORIGIN}/install/CAP/icon.png`,
      itms: itmsServicesUrl(`${ORIGIN}/install/CAP/manifest.plist`),
    });
    expect(installUrls(ORIGIN, "CAP", false).icon).toBeUndefined();
  });

  test("manifest XML-escapes every string and parses back", () => {
    const xml = buildManifest({
      ipaUrl: `${ORIGIN}/install/c/app.ipa?a=1&b=<2>`,
      iconUrl: `${ORIGIN}/install/c/icon.png`,
      bundleId: "com.example.app",
      version: "1.0 & \"beta\"",
      title: "</string><key>evil</key><string>'x'",
    });
    expect(xml).not.toContain("</string><key>evil");
    expect(xml).toContain("&lt;/string&gt;&lt;key&gt;evil&lt;/key&gt;&lt;string&gt;&apos;x&apos;");
    const plist = parseXmlPlist(xml) as any;
    const item = plist.items[0];
    expect(item.assets).toEqual([
      { kind: "software-package", url: `${ORIGIN}/install/c/app.ipa?a=1&b=<2>` },
      { kind: "display-image", url: `${ORIGIN}/install/c/icon.png` },
      { kind: "full-size-image", url: `${ORIGIN}/install/c/icon.png` },
    ]);
    expect(item.metadata).toEqual({
      "bundle-identifier": "com.example.app",
      "bundle-version": "1.0 & \"beta\"",
      kind: "software",
      title: "</string><key>evil</key><string>'x'",
    });
  });

  test("manifest without an icon has only the software-package asset", () => {
    const plist = parseXmlPlist(buildManifest({ ipaUrl: "https://x/app.ipa", bundleId: "b", version: "1", title: "t" })) as any;
    expect(plist.items[0].assets).toEqual([{ kind: "software-package", url: "https://x/app.ipa" }]);
  });

  test("xmlEscape", () => {
    expect(xmlEscape(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
  });

  test("xmlEscape drops characters XML 1.0 forbids and keeps valid ones", () => {
    expect(xmlEscape("a\u0000b\u0007c\u000Bd\u000Ce\u001Ff\uFFFEg\uFFFF")).toBe("abcdefg");
    expect(xmlEscape("lone\uD800 \uDC00x")).toBe("lone x");
    expect(xmlEscape("tab\tlf\ncr\r \u00E9 \u{1F600}")).toBe("tab\tlf\ncr\r \u00E9 \u{1F600}");
    const manifest = buildManifest({ ipaUrl: "https://x/app.ipa", bundleId: "com.x", version: "1", title: "Bad\u0001\uD83DName" });
    expect((parseXmlPlist(manifest) as any).items[0].metadata.title).toBe("BadName");
  });

  test("install page escapes values, has one Install link and no scripts or external resources", () => {
    const html = buildInstallPage({
      appName: "<script>alert(1)</script>",
      version: "1\"><img src=x>",
      build: "2",
      itmsUrl: "itms-services://?action=download-manifest&url=https%3A%2F%2Fx",
      hasIcon: true,
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('href="itms-services://?action=download-manifest&amp;url=https%3A%2F%2Fx"');
    expect(html.match(/<a /g)?.length).toBe(1);
    expect(html).toContain('<img src="icon.png" alt="">');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain("Requires iOS; the device must be in the app's provisioning profile.");
    expect(buildInstallPage({ appName: "A", version: "1", build: "1", itmsUrl: "x", hasIcon: false })).not.toContain("<img");
  });

  test("CSP allows only the page's own inline style (by hash) and icon", () => {
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).not.toContain("unsafe-inline");
    const html = buildInstallPage({ appName: "A", version: "1", build: "1", itmsUrl: "x", hasIcon: false });
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const hash = createHash("sha256").update(style).digest("base64");
    expect(PAGE_CSP).toContain(`style-src 'sha256-${hash}'`);
  });
});

describe("parseRange", () => {
  test("single ranges", () => {
    expect(parseRange(undefined, 100)).toBeUndefined();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-1000", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=-1000", 100)).toEqual({ start: 0, end: 99 });
  });
  test("unsatisfiable vs ignored", () => {
    expect(parseRange("bytes=100-", 100)).toBeNull();
    expect(parseRange("bytes=-0", 100)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeUndefined();
    expect(parseRange("items=0-1", 100)).toBeUndefined();
    expect(parseRange("bytes=9-1", 100)).toBeUndefined();
  });
});

describe("strictTargetPath", () => {
  test("strips the query and keeps ordinary paths", () => {
    expect(strictTargetPath("/install/abc/")).toBe("/install/abc/");
    expect(strictTargetPath("/install/abc/app.ipa?x=1")).toBe("/install/abc/app.ipa");
    expect(strictTargetPath("/install/abc/.hidden..x")).toBe("/install/abc/.hidden..x");
  });
  test("refuses non-origin-form targets, dot segments, backslashes and encoded separators", () => {
    for (const bad of [
      "", "*", "install/a/", "//a/b", "http://h/install/a/",
      "/a/./b", "/a/../b", "/a/.", "/a/..", "/..", "/./",
      "/a/%2e/b", "/a/%2E%2E/b", "/a%2fb", "/a%2Fb", "/a%5cb", "/a%5Cb", "/a\\b", "/a#b", "/a?q=%2e",
    ]) expect({ bad, path: strictTargetPath(bad) }).toEqual({ bad, path: null });
  });
});

describe("routing", () => {
  test("page, manifest, ipa and icon on the right cap", async () => {
    const icon = fakePng(false, 50);
    const { cap } = await start({ icon });
    const page = await get(`/install/${cap}/`);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe(PAGE_CSP);
    expect(page.body.toString()).toContain("OTA &lt;Test&gt; &amp; &quot;Co&quot;");
    expect(page.body.toString()).toContain("1.0 (7)");
    expectSecurityHeaders(page);

    const manifest = await get(`/install/${cap}/manifest.plist`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers["content-type"]).toBe("text/xml; charset=utf-8");
    const plist = parseXmlPlist(manifest.body.toString()) as any;
    expect(plist.items[0].assets[0]).toEqual({ kind: "software-package", url: `${ORIGIN}/install/${cap}/app.ipa` });
    expect(plist.items[0].metadata.title).toBe('OTA <Test> & "Co"');
    expectSecurityHeaders(manifest);

    const ipa = await get(`/install/${cap}/app.ipa`);
    expect(ipa.status).toBe(200);
    expect(ipa.headers["content-type"]).toBe("application/octet-stream");
    expect(ipa.headers["content-length"]).toBe(String(ipaBytes.length));
    expect(ipa.headers["accept-ranges"]).toBe("bytes");
    expect(ipa.body.equals(ipaBytes)).toBe(true);
    expectSecurityHeaders(ipa);

    const iconRes = await get(`/install/${cap}/icon.png`);
    expect(iconRes.status).toBe(200);
    expect(iconRes.headers["content-type"]).toBe("image/png");
    expect(iconRes.body.equals(icon)).toBe(true);
  });

  test("HEAD and Range on the ipa", async () => {
    const { cap } = await start();
    const head = await get(`/install/${cap}/app.ipa`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(ipaBytes.length));
    expect(head.body.length).toBe(0);

    const part = await get(`/install/${cap}/app.ipa`, { headers: { Range: "bytes=1000-1999" } });
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 1000-1999/${ipaBytes.length}`);
    expect(part.headers["content-length"]).toBe("1000");
    expect(part.body.equals(ipaBytes.subarray(1000, 2000))).toBe(true);

    const suffix = await get(`/install/${cap}/app.ipa`, { headers: { Range: "bytes=-10" } });
    expect(suffix.status).toBe(206);
    expect(suffix.body.equals(ipaBytes.subarray(ipaBytes.length - 10))).toBe(true);

    const bad = await get(`/install/${cap}/app.ipa`, { headers: { Range: `bytes=${ipaBytes.length}-` } });
    expect(bad.status).toBe(416);
    expect(bad.headers["content-range"]).toBe(`bytes */${ipaBytes.length}`);
  });

  test("everything else is a 404 that doesn't echo the path", async () => {
    const { cap } = await start();
    const other = generateCapability();
    const paths = [
      "/",
      "/install",
      "/install/",
      "/install//",
      `/install/${other}/`,
      `/install/${other}/app.ipa`,
      `/install/${cap.slice(0, 20)}/`,
      `/install/${cap}x/`,
      `/install/${cap}`,
      `/install/${cap}/icon.png`, // no icon this run
      `/install/${cap}/app.ipa/`,
      `/install/${cap}/../${cap}/app.ipa`,
      `/install/x/../${cap}/app.ipa`,
      `/install/${cap}/./app.ipa`,
      `/install/./${cap}/app.ipa`,
      `/install/${cap}/app.ipa/..`,
      `/install/${cap}/.`,
      `/install/${cap}/%2e/app.ipa`,
      `/install/${cap}%2Fapp.ipa`,
      `/install/${cap}/app%2eipa`,
      `/install/${cap}%5capp.ipa`,
      `/install/${cap}\\app.ipa`,
      `/install/${cap}/app.ipa?x=%2e`,
      `//install/${cap}/`,
      `http://127.0.0.1/install/${cap}/`,
      `/install/${cap}/Info.plist`,
      `/install/${cap}/manifest.plist.bak`,
      `/install/${other}/?token=x`,
      `/api?token=x`,
      `/install/x/?cap=${cap}`,
      `/INSTALL/${cap}/`,
    ];
    for (const path of paths) {
      const res = await get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(res.body.toString()).toBe("Not found\n");
      expectSecurityHeaders(res);
    }
  });

  test("query strings are ignored on the right cap and never grant access", async () => {
    const { cap } = await start();
    expect((await get(`/install/${cap}/?token=x`)).status).toBe(200);
    expect((await get(`/install/${generateCapability()}/app.ipa?token=${cap}`)).status).toBe(404);
  });

  test("only GET and HEAD", async () => {
    const { cap } = await start();
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      expect((await get(`/install/${cap}/`, { method })).status).toBe(404);
    }
  });

  test("404 before activation, after expiry and after revoke", async () => {
    let now = 1_000_000;
    const revoked: string[] = [];
    const { cap, install } = await start({ now: () => now, onRevoked: (r) => revoked.push(r) }, false);
    expect((await get(`/install/${cap}/`)).status).toBe(404);
    install.activate(ORIGIN, now + 1000);
    expect((await get(`/install/${cap}/`)).status).toBe(200);
    now += 1000;
    expect((await get(`/install/${cap}/`)).status).toBe(404);
    expect((await get(`/install/${cap}/app.ipa`)).status).toBe(404);
    expect(revoked).toEqual(["expired"]);
    expect(install.isLive).toBe(false);
  });

  test("manual revoke", async () => {
    const { cap, install } = await start();
    install.revoke();
    expect((await get(`/install/${cap}/manifest.plist`)).status).toBe(404);
  });
});

describe("--once", () => {
  test("revokes after one complete download, not after HEAD or a partial range", async () => {
    const events: string[] = [];
    const revoked: string[] = [];
    const { cap } = await start({ once: true, onEvent: (e) => events.push(e), onRevoked: (r) => revoked.push(r) });
    await get(`/install/${cap}/app.ipa`, { method: "HEAD" });
    await get(`/install/${cap}/app.ipa`, { headers: { Range: "bytes=0-99" } });
    expect(revoked).toEqual([]);
    expect((await get(`/install/${cap}/manifest.plist`)).status).toBe(200);
    const full = await get(`/install/${cap}/app.ipa`);
    expect(full.body.equals(ipaBytes)).toBe(true);
    await Bun.sleep(10);
    expect(revoked).toEqual(["once"]);
    expect(events).toContain("ipa-complete");
    expect((await get(`/install/${cap}/app.ipa`)).status).toBe(404);
    expect((await get(`/install/${cap}/`)).status).toBe(404);
  });

  test("ranges that together cover the file count as one download", async () => {
    const revoked: string[] = [];
    const { cap } = await start({ once: true, onRevoked: (r) => revoked.push(r) });
    const half = Math.floor(ipaBytes.length / 2);
    await get(`/install/${cap}/app.ipa`, { headers: { Range: `bytes=${half}-` } });
    await Bun.sleep(10);
    expect(revoked).toEqual([]);
    await get(`/install/${cap}/app.ipa`, { headers: { Range: `bytes=0-${half - 1}` } });
    await Bun.sleep(10);
    expect(revoked).toEqual(["once"]);
  });

  test("without --once, downloads don't revoke", async () => {
    const revoked: string[] = [];
    const { cap } = await start({ onRevoked: (r) => revoked.push(r) });
    await get(`/install/${cap}/app.ipa`);
    await get(`/install/${cap}/app.ipa`);
    await Bun.sleep(10);
    expect(revoked).toEqual([]);
    expect((await get(`/install/${cap}/app.ipa`)).status).toBe(200);
  });
});

beforeAll(() => {
  // The serve-sim API token must play no part in this server.
  process.env.SERVE_SIM_AUTH_TOKEN = "should-not-matter";
});
afterAll(() => {
  delete process.env.SERVE_SIM_AUTH_TOKEN;
});
