import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeToggle } from "../client/components/theme-toggle";

const clientDir = join(import.meta.dir, "../client");
const globalCss = readFileSync(join(clientDir, "global.css"), "utf8");

function block(selector: string): string {
  const start = globalCss.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return globalCss.slice(start, globalCss.indexOf("\n}", start));
}

function definedVars(css: string): Set<string> {
  return new Set([...css.matchAll(/^\s*(--serve-sim-[\w-]+):/gm)].map((m) => m[1]!));
}

function clientSources(dir = clientDir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return clientSources(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

describe("light/dark palettes", () => {
  const dark = definedVars(block(":root"));
  const light = definedVars(block(':root[data-theme="light"]'));

  test("the light palette overrides every dark token (and nothing else)", () => {
    expect(dark.size).toBeGreaterThan(20);
    expect([...dark].filter((v) => !light.has(v))).toEqual([]);
    expect([...light].filter((v) => !dark.has(v))).toEqual([]);
  });

  test("declares color-scheme for both palettes so UA widgets match", () => {
    expect(block(":root")).toContain("color-scheme: dark;");
    expect(block(':root[data-theme="light"]')).toContain("color-scheme: light;");
  });

  test("every --serve-sim-* variable referenced by the client is defined", () => {
    const referenced = new Set<string>();
    for (const file of clientSources()) {
      for (const m of readFileSync(file, "utf8").matchAll(/var\((--serve-sim-[\w-]+)/g)) referenced.add(m[1]!);
    }
    expect(referenced.size).toBeGreaterThan(10);
    expect([...referenced].filter((v) => !dark.has(v))).toEqual([]);
  });

  test("light mode boosts low-alpha text contrast; dark mode renders authored alpha", () => {
    expect(block(":root")).toContain("--serve-sim-text-k: 1;");
    expect(block(':root[data-theme="light"]')).toMatch(/--serve-sim-text-k: 0\.\d+;/);
    expect(globalCss).toContain("@utility text-ink-*");
  });
});

describe("client colors go through theme tokens", () => {
  // White-alpha utilities only read on a dark backdrop; panels/text should use
  // `ink` (white in dark, black in light). Fixed-white is fine where the
  // backdrop never changes (switch/slider knobs, the DevTools iframe).
  const ALLOWED = [
    /bg-white(\/50)?\b/, // knobs + DevTools iframe backing
  ];

  test("no white-alpha Tailwind classes outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of clientSources()) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?<![\w-])(?:[\w:&[\]-]+:)?(text|bg|border|ring|outline|fill|stroke)-white(?:\/[\w.[\]]+)?/g)) {
        const cls = m[0].replace(/^.*:/, "");
        if (cls.startsWith("bg-white") && ALLOWED.some((re) => re.test(cls))) continue;
        offenders.push(`${relative(clientDir, file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("Panel/toolbar chrome uses no hardcoded panel hexes", () => {
    for (const file of ["Panel.tsx", "simulator/SimulatorToolbar.tsx", "components/app-toasts.tsx", "components/select.tsx"]) {
      // `var(--token, #fallback)` fallbacks are fine (standalone use without global.css).
      const source = readFileSync(join(clientDir, file), "utf8").replace(/var\(--[\w-]+,[^)]*\)/g, "");
      const hits = source.match(/#1c1c1e|#181818|rgba\(255,\s*255,\s*255[^)]*\)/gi) ?? [];
      expect({ file, hits }).toEqual({ file, hits: [] });
    }
  });

  test("stream diagnostics UI (status pill, error panel) uses no color literals", () => {
    for (const file of ["components/stream-status-pill.tsx", "components/stream-error-panel.tsx"]) {
      const source = readFileSync(join(clientDir, file), "utf8").replace(/var\(--[\w-]+,[^)]*\)/g, "");
      const hits = source.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? [];
      expect({ file, hits }).toEqual({ file, hits: [] });
    }
  });
});

describe("ThemeToggle", () => {
  test("renders an accessible System / Light / Dark radio group", () => {
    const html = renderToStaticMarkup(<ThemeToggle preference="light" onChange={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Appearance"');
    for (const label of ["System", "Light", "Dark"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html.match(/aria-checked="true"/g)?.length).toBe(1);
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Light"/);
  });

  test("defaults to the system preference during server rendering", () => {
    const html = renderToStaticMarkup(<ThemeToggle />);
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="System"/);
  });
});

describe("compiled Tailwind CSS", () => {
  test("emits the ink utilities and both palettes", async () => {
    const { default: tailwind } = await import("bun-plugin-tailwind");
    const result = await Bun.build({ entrypoints: [join(clientDir, "global.css")], plugins: [tailwind] });
    expect(result.success).toBe(true);
    const css = await result.outputs[0]!.text();
    // `text-ink-*` must stay distinct from the `text-ink-inverse` color utility.
    expect(css).toMatch(/\.text-ink-55\s*\{[^}]*--serve-sim-text-k/);
    expect(css).toMatch(/\.text-ink-inverse\s*\{\s*color:\s*var\(--color-ink-inverse\)/);
    expect(css).toMatch(/\.bg-ink\\\/8\b/);
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain("--color-ink: var(--serve-sim-ink)");
  });
});
