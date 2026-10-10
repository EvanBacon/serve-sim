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
        className="pointer-events-auto max-w-[420px] rounded-xl px-4 py-3 text-[13px] leading-[1.4]"
        style={{ background: "rgba(28,28,30,0.92)", color: "#f2f2f7", border: "1px solid rgba(248,113,113,0.45)" }}
      >
        <div className="font-semibold" style={{ color: "#f87171" }}>{title}</div>
        <div className="mt-1">{error.reason}</div>
        <div className="mt-1 font-mono text-[11px]" style={{ color: "#8e8e93" }}>
          {[error.error, error.stage && `stage=${error.stage}`, error.status ? `HTTP ${error.status}` : null].filter(Boolean).join(" · ")}
          {retry ? ` · ${retry}` : ""}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[12px] font-medium"
            style={{ background: "#3a3a3c", color: "#f2f2f7" }}
            onClick={() => { void copyDiagnostics(diagnosticsEndpoint).then(setStatus); }}
          >
            Copy diagnostics
          </button>
          {status && <span className="text-[11px]" style={{ color: "#8e8e93" }}>{status}</span>}
        </div>
      </div>
    </div>
  );
}
