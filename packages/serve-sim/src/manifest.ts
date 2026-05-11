import { readFileSync } from "fs";
import { resolve } from "path";

export interface SessionApp {
  label?: string;
  device: string;
  appPath: string;
  bundleId: string;
  displayName?: string;
}

export interface SessionManifest {
  session?: string;
  apps: SessionApp[];
}

function assertString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`manifest apps[${index}].${field} must be a non-empty string`);
  }
  return value;
}

export function parseSessionManifest(contents: string, baseDir = process.cwd()): SessionManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (err) {
    throw new Error(`manifest must be valid JSON: ${(err as Error).message}`);
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("manifest must be a JSON object");
  }

  const source = raw as Record<string, unknown>;
  if (!Array.isArray(source.apps) || source.apps.length === 0) {
    throw new Error("manifest must contain a non-empty apps array");
  }

  return {
    session: typeof source.session === "string" ? source.session : undefined,
    apps: source.apps.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`manifest apps[${index}] must be an object`);
      }

      const app = entry as Record<string, unknown>;
      const appPath = assertString(app.appPath, "appPath", index);
      const displayName = typeof app.displayName === "string" && app.displayName.trim()
        ? app.displayName
        : undefined;

      return {
        label: typeof app.label === "string" && app.label.trim() ? app.label : undefined,
        device: assertString(app.device, "device", index),
        appPath: resolve(baseDir, appPath),
        bundleId: assertString(app.bundleId, "bundleId", index),
        displayName,
      };
    }),
  };
}

export function loadSessionManifest(path: string): SessionManifest {
  const absolute = resolve(path);
  return parseSessionManifest(readFileSync(absolute, "utf-8"), resolve(absolute, ".."));
}
