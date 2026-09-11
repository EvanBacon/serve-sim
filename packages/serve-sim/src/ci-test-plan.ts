/**
 * Which serve-sim tests need a Darwin runner (booted sim and/or native helper)
 * vs which can run with full concurrency on Ubuntu.
 *
 * Paths are repo-root-relative so GitHub Actions `paths:` filters and
 * `bun test` invocations stay in lockstep (see ci-test-plan.test.ts).
 */
export const SIM_E2E_TEST_FILES = [
  "packages/serve-sim/src/__tests__/accessibility-endpoint.test.ts",
  "packages/serve-sim/src/__tests__/avcc-stream-endpoint.test.ts",
  "packages/serve-sim/src/__tests__/camera-connections.e2e.test.ts",
  "packages/serve-sim/src/__tests__/hid-malformed-input.test.ts",
  "packages/serve-sim/src/__tests__/idle-floor.test.ts",
  "packages/serve-sim/src/__tests__/permissions.e2e.test.ts",
  "packages/serve-sim/src/__tests__/type-command-sim.test.ts",
  "packages/serve-sim/src/__tests__/ui-settings.e2e.test.ts",
] as const;

export const DARWIN_INTEGRATION_TEST_FILES = [
  "packages/serve-sim/src/__tests__/shm-probe.integration.test.ts",
] as const;

const DARWIN_TEST_FILE_SET = new Set<string>([
  ...SIM_E2E_TEST_FILES,
  ...DARWIN_INTEGRATION_TEST_FILES,
]);

export function isDarwinTestFile(file: string): boolean {
  return DARWIN_TEST_FILE_SET.has(normalizeRepoPath(file));
}

/** Paths that should not, by themselves, spend a macOS e2e slot. */
export function isDarwinSkipPath(file: string): boolean {
  const normalized = normalizeRepoPath(file);
  if (normalized.endsWith(".md")) return true;
  if (normalized.startsWith("packages/serve-sim/src/client/")) return true;
  if (normalized.startsWith("packages/serve-sim/docs/")) return true;
  if (normalized.startsWith("packages/serve-sim/src/__tests__/")) {
    return !isDarwinTestFile(normalized);
  }
  return false;
}

export function needsDarwinE2E(changedFiles: string[]): boolean {
  if (changedFiles.length === 0) return true;
  return changedFiles.some((file) => !isDarwinSkipPath(file));
}

function normalizeRepoPath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}
