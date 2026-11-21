import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Bell, Link2, Play, Search, Settings, Square, X, type LucideIcon } from "lucide-react";
import { hostAction, type HostActionFn } from "../utils/exec";
import {
  LINKING_ACTIONS,
  SYSTEM_HISTORY_KEY,
  actionNeedsApp,
  describeInvocation,
  linkingActionLabel,
  linkingHistoryReducer,
  linkingSuggestions,
  linkingTarget,
  readLinkingHistory,
  urlProblem,
  writeLinkingHistory,
  type LinkingActionKey,
  type LinkingInvocation,
} from "../utils/linking";
import { CollapsibleSection } from "./collapsible-section";

export interface LinkingInfo {
  displayName: string | null;
  schemes: string[];
  domains: string[];
}

const ACTION_ICONS: Record<LinkingActionKey, LucideIcon> = {
  spotlight: Search,
  launch: Play,
  terminate: Square,
  settings: Settings,
  notificationSettings: Bell,
};

/** Bundle id sent with Search while no real app is targeted (needs a query). */
const NO_APP_BUNDLE_ID = "com.apple.springboard";

function defaultStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/**
 * Linking: one search-style bar that opens URLs in the simulator, a chip
 * row of the app's schemes and non-URL ways in (Spotlight, launch,
 * Settings pages), and a short per-app history to rerun.
 */
export function LinkingTool({
  udid,
  bundleId: foreground,
  host = hostAction,
  storage = defaultStorage(),
  defaultOpen = false,
  initialInfo = null,
}: {
  udid: string;
  bundleId: string | null;
  host?: HostActionFn;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  defaultOpen?: boolean;
  /** Seed for `linkingInfo` (tests / server render). */
  initialInfo?: LinkingInfo | null;
}) {
  // Sticky: Spotlight, Settings and other system UI that the tokens bring
  // up never become the target (see isSystemSurface).
  const targetRef = useRef<string | null>(null);
  const target = linkingTarget(foreground, targetRef.current);
  targetRef.current = target;
  const historyKey = target ?? SYSTEM_HISTORY_KEY;
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState("");
  const [token, setToken] = useState<LinkingActionKey | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<{ key: string; value: LinkingInfo } | null>(
    () => (initialInfo && target ? { key: `${udid}|${target}`, value: initialInfo } : null),
  );
  const [history, setHistory] = useState<LinkingInvocation[]>(() => readLinkingHistory(historyKey, storage));
  const inputRef = useRef<HTMLInputElement>(null);

  const appKey = `${udid}|${historyKey}`;
  const appKeyRef = useRef(appKey);
  appKeyRef.current = appKey;

  // Per-app state follows the foreground app.
  useEffect(() => {
    setHistory(readLinkingHistory(historyKey, storage));
    setError(null);
    setToken(null);
    setText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appKey]);

  useEffect(() => {
    if (!open || !target) return;
    const key = `${udid}|${target}`;
    let cancelled = false;
    host("linkingInfo", { udid, bundleId: target }).then((res) => {
      if (cancelled || appKeyRef.current !== key || res.exitCode !== 0) return;
      setInfo({
        key,
        value: {
          displayName: typeof res.displayName === "string" ? res.displayName : null,
          schemes: Array.isArray(res.schemes) ? (res.schemes as string[]) : [],
          domains: Array.isArray(res.domains) ? (res.domains as string[]) : [],
        },
      });
    }, () => {});
    return () => { cancelled = true; };
  }, [open, udid, target, host]);

  const current = info && info.key === appKey ? info.value : null;

  const invoke = useCallback(async (entry: LinkingInvocation) => {
    if (pending || (entry.kind === "action" && actionNeedsApp(entry.action) && !target)) return;
    const bundleId = target ?? NO_APP_BUNDLE_ID;
    setPending(true);
    setError(null);
    try {
      const res = entry.kind === "url"
        ? await host("openUrl", { udid, url: entry.url })
        : await host("linkingAction", { udid, bundleId, action: entry.action, ...(entry.query ? { query: entry.query } : {}) });
      if (res.exitCode !== 0) {
        setError(res.stderr.trim() || `Failed (exit ${res.exitCode})`);
        return;
      }
      setHistory((prev) => {
        const next = linkingHistoryReducer(prev, { type: "add", entry });
        writeLinkingHistory(historyKey, next, storage);
        return next;
      });
      setText("");
      setToken(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }, [target, historyKey, pending, host, udid, storage]);

  const submit = () => {
    if (token) {
      const takesQuery = LINKING_ACTIONS.find((a) => a.key === token)?.takesQuery;
      const query = takesQuery ? text.trim() : "";
      void invoke(query ? { kind: "action", action: token, query } : { kind: "action", action: token });
      return;
    }
    const url = text.trim();
    const problem = urlProblem(url);
    if (problem) { setError(problem); return; }
    void invoke({ kind: "url", url });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Backspace" && token && text === "") { e.preventDefault(); setToken(null); }
    else if (e.key === "Escape") { setToken(null); setText(""); setError(null); }
  };

  const clearHistory = () => {
    setHistory(linkingHistoryReducer(history, { type: "clear" }));
    writeLinkingHistory(historyKey, [], storage);
  };

  const pickToken = (key: LinkingActionKey) => {
    if (actionNeedsApp(key) && !target) return;
    setToken(key);
    setText("");
    setError(null);
    inputRef.current?.focus();
  };

  const pickScheme = (value: string) => {
    setText(value);
    setError(null);
    inputRef.current?.focus();
  };

  // Nothing in front yet (detection hasn't answered): nothing to show.
  if (!target && !foreground) return null;
  const noApp = !target;

  const suggestions = token ? [] : linkingSuggestions(text, current);
  const tokenInfo = token ? LINKING_ACTIONS.find((a) => a.key === token)! : null;
  const placeholder = tokenInfo
    ? tokenInfo.takesQuery ? (current?.displayName ?? (noApp ? "Search for…" : "Search")) : "Press Return"
    : "Open URL";
  const showChips = !token && text === "";
  const listId = `linking-suggestions-${udid}`;

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      data-testid="linking-tool"
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-ink-50 uppercase tracking-[0.08em] leading-none inline-flex items-center">Linking</span>
          <span className="text-[11px] text-ink-50 truncate min-w-0 text-right" data-testid="linking-target">
            {current?.displayName ?? ""}
          </span>
        </>
      }
    >
      <label
        data-testid="linking-bar"
        className="flex items-center gap-1.5 px-2.5 h-8 rounded-lg bg-ink/6 focus-within:bg-ink/10 [transition:background_0.12s]"
      >
        {pending ? (
          <span
            role="status"
            aria-label="Running"
            className="size-3 shrink-0 rounded-full border border-ink/30 border-t-ink/95 animate-[grid-spin_0.7s_linear_infinite]"
          />
        ) : (
          <Link2 size={14} strokeWidth={2} className="text-icon shrink-0" />
        )}
        {tokenInfo && (
          <Chip
            data-linking-token={tokenInfo.key}
            icon={ACTION_ICONS[tokenInfo.key]}
            title="Remove"
            selected
            onClick={() => { setToken(null); inputRef.current?.focus(); }}
          >
            {tokenInfo.label}
          </Chip>
        )}
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => { setText(e.target.value); setError(null); }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Open URL or run a linking token"
          list={suggestions.length > 0 ? listId : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={pending}
          className="min-w-0 flex-1 bg-transparent border-none outline-none text-[12px] text-ink-90 placeholder:text-ink-40 font-mono"
        />
        {suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((s) => <option key={s} value={s} />)}
          </datalist>
        )}
      </label>

      {showChips && (
        <div data-testid="linking-chips" className="flex flex-wrap gap-1">
          {current?.schemes.map((scheme) => (
            <Chip key={`s:${scheme}`} data-linking-scheme={scheme} onClick={() => pickScheme(`${scheme}://`)} mono>
              {scheme}://
            </Chip>
          ))}
          {LINKING_ACTIONS.map((a) => (
            <Chip
              key={a.key}
              data-linking-action={a.key}
              icon={ACTION_ICONS[a.key]}
              disabled={noApp && actionNeedsApp(a.key)}
              title={noApp && actionNeedsApp(a.key) ? "Open an app first" : undefined}
              onClick={() => pickToken(a.key)}
            >
              {a.label}
            </Chip>
          ))}
        </div>
      )}

      {error && (
        <div role="alert" className="bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md">
          {error}
        </div>
      )}

      {history.length > 0 && (
        <div data-testid="linking-history" className="flex flex-col">
          <div className="flex items-center justify-between px-0.5 pb-0.5">
            <span className="text-[10px] font-semibold text-ink-50 uppercase tracking-[0.08em]">Recent</span>
            <button
              type="button"
              onClick={clearHistory}
              className="bg-transparent border-none p-0 text-[11px] text-ink-55 hover:text-ink-90 cursor-pointer"
            >
              Clear
            </button>
          </div>
          {history.map((entry) => {
            const Icon = entry.kind === "url" ? Link2 : ACTION_ICONS[entry.action];
            const label = describeInvocation(entry);
            const unavailable = noApp && entry.kind === "action" && actionNeedsApp(entry.action);
            return (
              <button
                key={`${entry.kind}:${label}`}
                type="button"
                disabled={pending || unavailable}
                onClick={() => void invoke(entry)}
                title={entry.kind === "url" ? `Open ${entry.url}` : `Run ${linkingActionLabel(entry.action)}`}
                className="flex items-center gap-2 px-1 py-1 rounded-md bg-transparent border-none text-left cursor-pointer hover:bg-ink/6 disabled:cursor-default"
              >
                <Icon size={12} strokeWidth={2} className="text-icon shrink-0" />
                <span className={`text-[12px] text-ink-90 truncate min-w-0 ${entry.kind === "url" ? "font-mono" : ""}`}>{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}

function Chip({
  children,
  icon: Icon,
  onClick,
  selected = false,
  mono = false,
  disabled = false,
  title,
  ...dataProps
}: {
  children: ReactNode;
  icon?: LucideIcon;
  onClick: () => void;
  selected?: boolean;
  mono?: boolean;
  disabled?: boolean;
  title?: string;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <button
      type="button"
      title={title}
      // Keep focus in the bar so picking a chip doesn't blur it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      className={`shrink-0 inline-flex items-center gap-1 h-[22px] px-2 rounded-full border-none text-[11px] leading-none [transition:background_0.12s] ${
        disabled
          ? "bg-ink/4 text-ink-50 cursor-default"
          : selected ? "bg-accent/15 text-accent cursor-pointer" : "bg-ink/6 text-ink-70 hover:bg-ink/10 hover:text-ink-90 cursor-pointer"
      } ${mono ? "font-mono" : ""}`}
      {...dataProps}
    >
      {Icon && <Icon size={11} strokeWidth={2.2} className="shrink-0" />}
      {children}
      {selected && <X size={10} strokeWidth={2.6} className="shrink-0" />}
    </button>
  );
}
