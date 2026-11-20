import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  betaPlan,
  bumpBranchName,
  bumpPrBody,
  bumpPrTitle,
  findReusableBumpPr,
  nextBetaVersion,
  nextPatch,
  normalizeVersions,
  planBumpOnMain,
  releaseTagName,
  stablePlan,
  tagDecision,
  writePackageVersion,
} from "../../scripts/publish-version.mjs";

const currentNpm = [
  "0.1.49",
  "0.1.50-beta.178.1",
  "0.1.50-beta.177.1",
  "0.1.50-beta.144.1",
];

describe("normalizeVersions", () => {
  test("treats a missing package as no versions", () => {
    expect(normalizeVersions(null)).toEqual([]);
  });

  test("wraps a single published version", () => {
    expect(normalizeVersions("0.1.0")).toEqual(["0.1.0"]);
  });

  test("passes an array through", () => {
    expect(normalizeVersions(["0.1.0", "0.1.1"])).toEqual(["0.1.0", "0.1.1"]);
  });
});

describe("nextBetaVersion", () => {
  test("starts a new base at beta.0", () => {
    expect(nextBetaVersion("0.1.51", currentNpm)).toBe("0.1.51-beta.0");
    expect(nextBetaVersion("0.1.51", [])).toBe("0.1.51-beta.0");
  });

  test("counts legacy beta.N.M versions by N so the next number sorts above them", () => {
    expect(nextBetaVersion("0.1.50", currentNpm)).toBe("0.1.50-beta.179");
    expect(
      nextBetaVersion("0.1.50", ["0.1.50-beta.178", "0.1.50-beta.178.1"]),
    ).toBe("0.1.50-beta.179");
  });

  test("ignores betas of other bases", () => {
    expect(
      nextBetaVersion("0.1.51", ["0.1.50-beta.178.1", "0.1.51-beta.2"]),
    ).toBe("0.1.51-beta.3");
  });
});

describe("betaPlan", () => {
  test("returns the next beta when package.json is ahead of latest", () => {
    expect(betaPlan("0.1.50", currentNpm, "0.1.49")).toBe("0.1.50-beta.179");
  });

  test("fails if package.json is already a published stable", () => {
    expect(() => betaPlan("0.1.49", currentNpm, "0.1.49")).toThrow(
      /already published as a stable release/,
    );
  });

  test("fails if package.json is behind npm latest", () => {
    expect(() => betaPlan("0.1.46", currentNpm, "0.1.49")).toThrow(
      /not ahead of npm latest 0.1.49/,
    );
  });
});

describe("stablePlan", () => {
  test("publishes package.json when that version is not on npm", () => {
    expect(stablePlan("0.1.50", currentNpm, "0.1.49")).toEqual({
      action: "publish",
      version: "0.1.50",
    });
  });

  test("skips when the version is already on npm so a rerun can tag and bump", () => {
    expect(stablePlan("0.1.49", currentNpm, "0.1.49")).toEqual({
      action: "skip",
      version: "0.1.49",
    });
  });

  test("fails if package.json is behind npm latest", () => {
    expect(() => stablePlan("0.1.46", currentNpm, "0.1.49")).toThrow(
      /behind npm latest 0.1.49/,
    );
  });
});

describe("nextPatch", () => {
  test("increments the patch", () => {
    expect(nextPatch("0.1.50")).toBe("0.1.51");
  });
});

describe("release tag and bump PR", () => {
  test("names the git tag and the bump PR from the version", () => {
    expect(releaseTagName("0.1.50")).toBe("v0.1.50");
    expect(bumpBranchName("0.1.51")).toBe("chore/bump-serve-sim-to-0.1.51");
    expect(bumpPrTitle("0.1.51")).toBe("chore: bump serve-sim to 0.1.51");
    expect(
      bumpPrBody({
        released: "0.1.50",
        next: "0.1.51",
        tag: "v0.1.50",
      }),
    ).toContain("GITHUB_TOKEN");
  });

  test("reuses a tag that already points at HEAD and refuses to move one", () => {
    expect(tagDecision(null, "abc")).toEqual({ action: "create" });
    expect(tagDecision("-", "abc")).toEqual({ action: "create" });
    expect(tagDecision("abc", "abc")).toEqual({ action: "reuse" });
    expect(() => tagDecision("old", "abc")).toThrow(/already points at old/);
  });

  test("opens a bump PR only when main is still at the released version", () => {
    expect(planBumpOnMain("0.1.50", "0.1.50")).toEqual({
      action: "open",
      next: "0.1.51",
    });
    expect(planBumpOnMain("0.1.51", "0.1.50")).toEqual({
      action: "skip",
      next: "0.1.51",
    });
    expect(() => planBumpOnMain("0.1.49", "0.1.50")).toThrow(
      /origin\/main package.json is 0.1.49/,
    );
  });

  test("reuses an open bump PR by head branch, then by title", () => {
    const openByHead = {
      state: "open",
      title: "other",
      html_url: "https://example/1",
      number: 1,
      head: { ref: "chore/bump-serve-sim-to-0.1.51" },
      base: { ref: "main" },
    };
    const openByTitle = {
      state: "open",
      title: "chore: bump serve-sim to 0.1.51",
      html_url: "https://example/2",
      number: 2,
      head: { ref: "old-branch" },
      base: { ref: "main" },
    };
    const closed = {
      state: "closed",
      title: "chore: bump serve-sim to 0.1.51",
      html_url: "https://example/3",
      number: 3,
      head: { ref: "chore/bump-serve-sim-to-0.1.51" },
      base: { ref: "main" },
    };
    expect(
      findReusableBumpPr([closed, openByTitle, openByHead], {
        branch: "chore/bump-serve-sim-to-0.1.51",
        title: "chore: bump serve-sim to 0.1.51",
      }),
    ).toBe(openByHead);
    expect(
      findReusableBumpPr([closed, openByTitle], {
        branch: "chore/bump-serve-sim-to-0.1.51",
        title: "chore: bump serve-sim to 0.1.51",
      }),
    ).toBe(openByTitle);
    expect(
      findReusableBumpPr([closed], {
        branch: "chore/bump-serve-sim-to-0.1.51",
        title: "chore: bump serve-sim to 0.1.51",
      }),
    ).toBeNull();
  });
});

describe("writePackageVersion", () => {
  const previous = process.env.SERVE_SIM_PACKAGE_JSON;
  afterEach(() => {
    if (previous == null) delete process.env.SERVE_SIM_PACKAGE_JSON;
    else process.env.SERVE_SIM_PACKAGE_JSON = previous;
  });

  test("updates only the version field", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-version-"));
    const path = join(dir, "package.json");
    writeFileSync(
      path,
      `${JSON.stringify({ name: "serve-sim", version: "0.1.50", license: "Apache-2.0" }, null, 2)}\n`,
    );
    writePackageVersion("0.1.50-beta.179", path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      name: "serve-sim",
      version: "0.1.50-beta.179",
      license: "Apache-2.0",
    });
  });
});
