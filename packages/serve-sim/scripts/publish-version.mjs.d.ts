export const PACKAGE_NAME: "serve-sim";
export const STABLE_RE: RegExp;

export function packageJsonPath(): string;
export function escapeRe(value: string): string;
export function parseStable(
  version: string,
  label: string,
): { major: number; minor: number; patch: number; raw: string };
export function compareStable(a: string, b: string): number;
export function nextPatch(version: string): string;
export function normalizeVersions(raw: unknown): string[];
export function betaIndex(base: string, version: string): number | null;
export function nextBetaVersion(base: string, versions: string[]): string;
export function betaPlan(
  local: string,
  versions: string[],
  latest: string | null | undefined,
): string;
export function stablePlan(
  local: string,
  versions: string[],
  latest: string | null | undefined,
): { action: "publish" | "skip"; version: string };
export function releaseTagName(version: string): string;
export function bumpBranchName(nextVersion: string, packageName?: string): string;
export function bumpPrTitle(nextVersion: string, packageName?: string): string;
export function bumpPrBody(options: {
  packageName?: string;
  released: string;
  next: string;
  tag: string;
}): string;
export function tagDecision(
  existingSha: string | null | undefined,
  headSha: string,
): { action: "create" | "reuse" };
export function planBumpOnMain(
  mainVersion: string,
  releasedVersion: string,
): { action: "open" | "skip"; next: string };

export type PullRef = { ref?: string } | string;
export type Pull = {
  state?: string;
  title?: string;
  html_url?: string;
  number?: number;
  head?: PullRef;
  base?: PullRef;
};

export function findReusableBumpPr(
  pulls: Pull[],
  options: { branch: string; title: string; base?: string },
): Pull | null;
export function readPackageVersion(path?: string): string;
export function writePackageVersion(version: string, path?: string): void;
export function npmView(args: string[]): unknown;
export function loadRegistry(): { versions: string[]; latest: string | null };
export function main(argv?: string[]): string;
