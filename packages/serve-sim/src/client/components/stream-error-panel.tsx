import { useState } from "react";
import type { StreamError } from "../utils/stream-retry";

/** Fetch the doctor JSON and put it on the clipboard. Returns a status line. */
export async function copyDiagnostics(
  endpoint: string,
  writeText: (text: string) => Promise<void> = (text) => navigator.clipboard.writeText(text),
  doFetch: typeof fetch = fetch,
): Promise<string> {
  try {
    const res = await doFetch(endpoint, { cache: "no-store" });
    const text = await res.text();
    if (res.status === 403) return "Diagnostics are localhost-only. Run `serve-sim doctor --json` on the Mac.";
    if (res.status === 429) return "Diagnostics are rate-limited; try again in a few seconds.";
    if (!res.ok) return `Diagnostics failed (HTTP ${res.status}).`;
    await writeText(text);
    return "Copied diagnostics JSON.";
  } catch (error) {
    return `Could not copy diagnostics: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Inline error for a stream that is not producing frames, with a reason and a copy button. */
export function StreamErrorPanel({ title, error, diagnosticsEndpoint }: {
  title: string;
  error: StreamError;
  diagnosticsEndpoint: string;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const retry = error.retryInMs != null ? `Retrying in ${Math.max(1, Math.round(error.retryInMs / 1000))}s.` : null;
  return (
    <div
      role="alert"
      data-testid="stream-error-panel"
      className="absolute inset-0 flex items-center justify-center p-6 pointer-events-none"
    >
      <div
        className="pointer-events-auto max-w-[420px] rounded-xl px-4 py-3 text-[13px] leading-[1.4] bg-panel/92 text-ink-95 border border-danger/45 shadow-popover"
      >
        <div className="font-semibold text-danger">{title}</div>
        <div className="mt-1">{error.reason}</div>
        <div className="mt-1 font-mono text-[11px] text-icon">
          {[error.error, error.stage && `stage=${error.stage}`, error.status ? `HTTP ${error.status}` : null].filter(Boolean).join(" · ")}
          {retry ? ` · ${retry}` : ""}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[12px] font-medium bg-ink/12 text-ink-95"
            onClick={() => { void copyDiagnostics(diagnosticsEndpoint).then(setStatus); }}
          >
            Copy diagnostics
          </button>
          {status && <span className="text-[11px] text-icon">{status}</span>}
        </div>
      </div>
    </div>
  );
}
