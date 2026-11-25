/**
 * The HTTP side of `serve-sim install`: an OTA (itms-services) install page,
 * manifest and .ipa behind an unguessable per-run capability path.
 *
 * iOS's installer fetches the manifest and the .ipa itself, without cookies
 * or an Authorization header, so the path is the credential:
 *
 *   /install/<cap>/              install page
 *   /install/<cap>/manifest.plist
 *   /install/<cap>/app.ipa
 *   /install/<cap>/icon.png      (only when the app has a usable icon)
 *
 * Everything else, and everything after expiry or revocation, is a 404 that
 * never echoes the path. Query strings are ignored and never grant access.
 * This server exposes none of the serve-sim API and knows nothing of its
 * auth token.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { createReadStream } from "fs";
import type { IncomingMessage, ServerResponse } from "http";

/** 32 random bytes, base64url (43 chars). */
export function generateCapability(bytes: () => Buffer = () => randomBytes(32)): string {
  return bytes().toString("base64url");
}

/** @lintignore Exported for tests. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const htmlEscape = (value: string): string => xmlEscape(value).replace(/&apos;/g, "&#39;");

export interface InstallUrls {
  page: string;
  manifest: string;
  ipa: string;
  icon?: string;
  itms: string;
}

/** @lintignore Exported for tests. */
export function installUrls(publicOrigin: string, cap: string, hasIcon: boolean): InstallUrls {
  const base = `${publicOrigin.replace(/\/+$/, "")}/install/${cap}/`;
  const manifest = `${base}manifest.plist`;
  return {
    page: base,
    manifest,
    ipa: `${base}app.ipa`,
    ...(hasIcon ? { icon: `${base}icon.png` } : {}),
    itms: itmsServicesUrl(manifest),
  };
}

/** @lintignore Exported for tests. */
export function itmsServicesUrl(manifestUrl: string): string {
  return `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
}

interface ManifestInput {
  ipaUrl: string;
  iconUrl?: string;
  bundleId: string;
  version: string;
  title: string;
}

/** @lintignore Exported for tests. */
export function buildManifest(m: ManifestInput): string {
  const s = (v: string) => `<string>${xmlEscape(v)}</string>`;
  const asset = (kind: string, url: string) =>
    `        <dict>\n          <key>kind</key>${s(kind)}\n          <key>url</key>${s(url)}\n        </dict>`;
  const assets = [asset("software-package", m.ipaUrl)];
  if (m.iconUrl) assets.push(asset("display-image", m.iconUrl), asset("full-size-image", m.iconUrl));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
${assets.join("\n")}
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>${s(m.bundleId)}
        <key>bundle-version</key>${s(m.version)}
        <key>kind</key>${s("software")}
        <key>title</key>${s(m.title)}
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#6b6b70;--btn:#0a84ff;--btn-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#f2f2f7;--muted:#98989f}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:16px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-text-size-adjust:100%}
main{width:100%;max-width:360px;padding:32px 24px;text-align:center}
img{width:96px;height:96px;border-radius:22px;display:block;margin:0 auto 16px}
h1{font-size:24px;font-weight:600;margin:0 0 4px}
.v{color:var(--muted);margin:0 0 28px}
a.b{display:block;padding:15px;border-radius:14px;background:var(--btn);color:var(--btn-fg);font-size:18px;font-weight:600;text-decoration:none}
.n{color:var(--muted);font-size:13px;margin:20px 0 0}`;

const PAGE_STYLE_HASH = createHash("sha256").update(PAGE_STYLE).digest("base64");

/**
 * CSP for the page: no scripts, no external anything; only its own inline style and icon.
 * @lintignore Exported for tests.
 */
export const PAGE_CSP =
  `default-src 'none'; style-src 'sha256-${PAGE_STYLE_HASH}'; img-src 'self'; ` +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** @lintignore Exported for tests. */
export function buildInstallPage(p: { appName: string; version: string; build: string; itmsUrl: string; hasIcon: boolean }): string {
  const version = p.build && p.build !== p.version ? `${p.version} (${p.build})` : p.version;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Install ${htmlEscape(p.appName)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
${p.hasIcon ? '<img src="icon.png" alt="">\n' : ""}<h1>${htmlEscape(p.appName)}</h1>
<p class="v">${htmlEscape(version)}</p>
<a class="b" href="${htmlEscape(p.itmsUrl)}">Install</a>
<p class="n">Requires iOS; the device must be in the app's provisioning profile.</p>
</main>
</body>
</html>
`;
}

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

type Range = { start: number; end: number };

/**
 * Parse a single `bytes=` range. Returns null for unsatisfiable, undefined to serve the whole file.
 * @lintignore Exported for tests.
 */
export function parseRange(header: string | undefined, size: number): Range | null | undefined {
  if (!header) return undefined;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return undefined; // multi-range or malformed: ignore, serve 200
  const [, a, b] = m;
  if (a === "" && b === "") return undefined;
  let start: number;
  let end: number;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
    if (b !== "" && Number(b) < start) return undefined;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return null;
  return { start, end };
}

/** Merged byte ranges of the .ipa that were fully sent; for `--once`. */
class Coverage {
  private ranges: Range[] = [];
  complete = false;
  constructor(private readonly size: number) {}

  add(r: Range): boolean {
    this.ranges.push(r);
    this.ranges.sort((x, y) => x.start - y.start);
    const merged: Range[] = [];
    for (const cur of this.ranges) {
      const prev = merged[merged.length - 1];
      if (prev && cur.start <= prev.end + 1) prev.end = Math.max(prev.end, cur.end);
      else merged.push({ ...cur });
    }
    this.ranges = merged;
    this.complete = merged.length === 1 && merged[0]!.start === 0 && merged[0]!.end >= this.size - 1;
    return this.complete;
  }
}

export type InstallEvent = "page" | "manifest" | "ipa-start" | "ipa-complete";

export interface InstallServerOptions {
  cap: string;
  ipaPath: string;
  ipaSize: number;
  appName: string;
  bundleId: string;
  version: string;
  build: string;
  icon?: Buffer;
  /** Revoke after the .ipa has been downloaded completely once. */
  once?: boolean;
  now?: () => number;
  onEvent?: (event: InstallEvent) => void;
  /** Called once when the capability is revoked (expiry, --once, or revoke()). */
  onRevoked?: (reason: "expired" | "once" | "manual") => void;
}

const ROUTE_RE = /^\/install\/([^/]+)\/(|manifest\.plist|app\.ipa|icon\.png)$/;

export class InstallServer {
  private publicOrigin: string | undefined;
  private expiresAt = 0;
  private manifest = "";
  private page = "";
  private revoked = false;
  private readonly capBuf: Buffer;
  private readonly coverage: Coverage;
  private readonly now: () => number;

  constructor(private readonly opts: InstallServerOptions) {
    this.capBuf = Buffer.from(opts.cap, "utf8");
    this.coverage = new Coverage(opts.ipaSize);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Start serving under `origin` (must be https for iOS to accept the
   * manifest) until `expiresAt` (epoch ms). Everything 404s before this.
   */
  activate(origin: string, expiresAt: number): InstallUrls {
    this.publicOrigin = origin;
    this.expiresAt = expiresAt;
    const urls = installUrls(origin, this.opts.cap, !!this.opts.icon);
    this.manifest = buildManifest({
      ipaUrl: urls.ipa,
      iconUrl: urls.icon,
      bundleId: this.opts.bundleId,
      version: this.opts.version,
      title: this.opts.appName,
    });
    this.page = buildInstallPage({
      appName: this.opts.appName,
      version: this.opts.version,
      build: this.opts.build,
      itmsUrl: urls.itms,
      hasIcon: !!this.opts.icon,
    });
    return urls;
  }

  revoke(reason: "expired" | "once" | "manual" = "manual"): void {
    if (this.revoked) return;
    this.revoked = true;
    this.opts.onRevoked?.(reason);
  }

  get isLive(): boolean {
    return !this.revoked && this.now() < this.expiresAt;
  }

  private capMatches(candidate: string): boolean {
    const buf = Buffer.from(candidate, "utf8");
    if (buf.length !== this.capBuf.length) return false;
    return timingSafeEqual(buf, this.capBuf);
  }

  readonly handle = (req: IncomingMessage, res: ServerResponse): void => {
    for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const q = rawUrl.indexOf("?");
    const path = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
    const m = ROUTE_RE.exec(path);

    if (this.publicOrigin && !this.revoked && this.now() >= this.expiresAt) this.revoke("expired");
    if (!m || (method !== "GET" && method !== "HEAD") || !this.publicOrigin || !this.isLive || !this.capMatches(m[1]!)) {
      this.notFound(res);
      return;
    }
    switch (m[2]) {
      case "":
        this.opts.onEvent?.("page");
        this.send(res, method, 200, "text/html; charset=utf-8", Buffer.from(this.page), { "Content-Security-Policy": PAGE_CSP });
        return;
      case "manifest.plist":
        this.opts.onEvent?.("manifest");
        this.send(res, method, 200, "application/xml; charset=utf-8", Buffer.from(this.manifest));
        return;
      case "icon.png":
        if (!this.opts.icon) {
          this.notFound(res);
          return;
        }
        this.send(res, method, 200, "image/png", this.opts.icon);
        return;
      default:
        this.serveIpa(req, res, method);
    }
  };

  private notFound(res: ServerResponse): void {
    const body = Buffer.from("Not found\n");
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": body.length });
    res.end(body);
  }

  private send(res: ServerResponse, method: string, status: number, type: string, body: Buffer, extra: Record<string, string> = {}): void {
    res.writeHead(status, { ...extra, "Content-Type": type, "Content-Length": body.length });
    res.end(method === "HEAD" ? undefined : body);
  }

  private serveIpa(req: IncomingMessage, res: ServerResponse, method: string): void {
    const size = this.opts.ipaSize;
    const range = parseRange(req.headers.range, size);
    const headers: Record<string, string | number> = {
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Disposition": 'attachment; filename="app.ipa"',
    };
    if (range === null) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": 0 });
      res.end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, headers);
    if (method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    if (start === 0) this.opts.onEvent?.("ipa-start");
    const stream = createReadStream(this.opts.ipaPath, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    res.on("finish", () => {
      const wasComplete = this.coverage.complete;
      if (!this.coverage.add({ start, end })) return;
      if (wasComplete && !(start === 0 && end === size - 1)) return;
      this.opts.onEvent?.("ipa-complete");
      if (this.opts.once) this.revoke("once");
    });
    stream.pipe(res);
  }
}
