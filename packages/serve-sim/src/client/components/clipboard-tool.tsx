import { useEffect, useId, useRef, useState } from "react";
import { hostAction, type HostActionFn } from "../utils/exec";
import { CollapsibleSection } from "./collapsible-section";

export function ClipboardTool({ udid, host = hostAction }: { udid: string; host?: HostActionFn }) {
  // A new device gets a new draft and cannot inherit a pending copy's status.
  return <ClipboardForm key={udid} udid={udid} host={host} />;
}

function ClipboardForm({ udid, host }: { udid: string; host: HostActionFn }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Copy text here, then choose Paste in the simulator field.");
  const revision = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const copy = async () => {
    if (pending.current || !text) return;
    pending.current = true;
    const copiedRevision = revision.current;
    setBusy(true);
    setStatus("Copying…");
    try {
      const result = await host("copyClipboard", { udid, text });
      if (!mounted.current || revision.current !== copiedRevision) return;
      setStatus(result.exitCode === 0 && result.verified === true
        ? "Verified in simulator clipboard. Choose Paste in the simulator field."
        : `Copy failed: ${result.stderr || "clipboard was not verified."}`);
    } catch {
      if (mounted.current && revision.current === copiedRevision) {
        setStatus("Copy failed: control channel unavailable. Try again.");
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <CollapsibleSection open={open} onOpenChange={setOpen} summary={<span>Clipboard</span>}>
      <label htmlFor={id} className="text-xs text-ink-90">Text for simulator clipboard</label>
      <textarea
        id={id}
        rows={3}
        value={text}
        className="w-full resize-y rounded-md bg-ink-5 p-2 text-xs text-ink-90"
        onInput={event => {
          revision.current++;
          setText(event.currentTarget.value);
          setStatus("Text changed. Copy again before Paste in the simulator.");
        }}
      />
      <button
        type="button"
        className="rounded-md bg-ink-10 px-3 py-2 text-xs text-ink-90 disabled:opacity-50"
        disabled={busy || !text}
        onClick={() => void copy()}
      >Copy to simulator</button>
      <p role="status" className="text-xs text-ink-60">{status}</p>
    </CollapsibleSection>
  );
}
