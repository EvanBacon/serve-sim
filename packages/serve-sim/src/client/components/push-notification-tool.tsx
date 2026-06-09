import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Chevron } from "../icons";
import { fetchAppIcon } from "../utils/app-icon";
import { execOnHost, shellEscape } from "../utils/exec";

// Drives `xcrun simctl push <udid> <bundleId> <payload-file>`. The payload is
// piped through a base64-encoded mktemp shim so arbitrary JSON survives the
// shell round trip without escaping headaches. Recent bundle IDs are kept in
// localStorage so common targets surface in a dropdown next to the field.

const PUSH_RECENTS_KEY = "serve-sim:push-recents";
const PUSH_PAYLOAD_KEY = "serve-sim:push-payload";
const PUSH_RECENTS_LIMIT = 8;

interface PushRecent {
  bundleId: string;
  displayName?: string;
  lastUsed: number;
}

function loadPushRecents(): PushRecent[] {
  try {
    const raw = window.localStorage.getItem(PUSH_RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is PushRecent =>
      r && typeof r.bundleId === "string" && typeof r.lastUsed === "number",
    );
  } catch { return []; }
}

function savePushRecents(recents: PushRecent[]) {
  try {
    window.localStorage.setItem(
      PUSH_RECENTS_KEY,
      JSON.stringify(recents.slice(0, PUSH_RECENTS_LIMIT)),
    );
  } catch {}
}

const DEFAULT_PUSH_PAYLOAD = `{
  "aps": {
    "alert": {
      "title": "Hello",
      "body": "This is a test notification"
    },
    "sound": "default",
    "badge": 1
  }
}
`;

// JSON Schema describing simctl's accepted APNS payload. Used by the editor's
// completion engine to suggest property names + enum values based on where the
// caret sits in the document.
type JsonSchema =
  | { type?: "object"; properties?: Record<string, JsonSchema>; description?: string; oneOf?: JsonSchema[]; anyOf?: JsonSchema[]; required?: string[] }
  | { type?: "string"; description?: string; enum?: string[] }
  | { type?: "number" | "integer" | "boolean" | "null" | "array"; description?: string; items?: JsonSchema; enum?: any[] }
  | { description?: string; oneOf?: JsonSchema[]; anyOf?: JsonSchema[] };

const APNS_ALERT_SCHEMA: JsonSchema = {
  type: "object",
  description: "APS alert. Use a string for a simple body or an object for rich content.",
  properties: {
    title: { type: "string", description: "Short title shown above the body." },
    subtitle: { type: "string", description: "Secondary description below the title." },
    body: { type: "string", description: "Main message body." },
    "launch-image": { type: "string", description: "Filename of the launch image to display." },
    "title-loc-key": { type: "string", description: "Localization key for the title." },
    "title-loc-args": { type: "array", description: "Variables substituted into title-loc-key." },
    "subtitle-loc-key": { type: "string", description: "Localization key for the subtitle." },
    "subtitle-loc-args": { type: "array", description: "Variables substituted into subtitle-loc-key." },
    "loc-key": { type: "string", description: "Localization key for the body." },
    "loc-args": { type: "array", description: "Variables substituted into loc-key." },
    "summary-arg": { type: "string", description: "String for grouped notifications summary." },
    "summary-arg-count": { type: "integer", description: "Count for grouped notifications summary." },
  },
};

const APNS_SOUND_SCHEMA: JsonSchema = {
  type: "object",
  description: "Critical or custom sound configuration.",
  properties: {
    name: { type: "string", description: "Sound file in the app bundle, or 'default'." },
    critical: { type: "integer", enum: [0, 1], description: "1 to play even when device is muted (entitlement required)." },
    volume: { type: "number", description: "0.0 – 1.0 volume for critical sounds." },
  },
};

const APNS_APS_SCHEMA: JsonSchema = {
  type: "object",
  description: "Apple-defined push payload metadata.",
  properties: {
    alert: { oneOf: [{ type: "string" }, APNS_ALERT_SCHEMA], description: "Notification alert (string body or rich object)." },
    badge: { type: "integer", description: "App icon badge number. 0 clears it." },
    sound: { oneOf: [{ type: "string" }, APNS_SOUND_SCHEMA], description: "Sound file name or critical-sound object." },
    "thread-id": { type: "string", description: "Identifier used to group related notifications." },
    category: { type: "string", description: "UNNotificationCategory identifier for actions." },
    "content-available": { type: "integer", enum: [0, 1], description: "1 wakes the app for background fetch." },
    "mutable-content": { type: "integer", enum: [0, 1], description: "1 lets a Notification Service Extension modify the payload." },
    "target-content-id": { type: "string", description: "Identifier of the window brought forward when tapped." },
    "interruption-level": {
      type: "string",
      enum: ["passive", "active", "time-sensitive", "critical"],
      description: "iOS 15+ delivery prominence.",
    },
    "relevance-score": { type: "number", description: "iOS 15+ summary ordering score (0.0 – 1.0)." },
    "filter-criteria": { type: "string", description: "Focus filter criteria string." },
    "stale-date": { type: "integer", description: "Unix timestamp after which the notification is stale." },
    "dismissal-date": { type: "integer", description: "Unix timestamp at which the notification auto-dismisses." },
    "event": { type: "string", description: "Live Activity event: 'update' or 'end'." },
    "timestamp": { type: "integer", description: "Live Activity event timestamp (Unix seconds)." },
  },
};

const APNS_PAYLOAD_SCHEMA: JsonSchema = {
  type: "object",
  description: "APNS push payload accepted by `xcrun simctl push`.",
  properties: {
    aps: APNS_APS_SCHEMA,
    "Simulator Target Bundle": {
      type: "string",
      description: "Optional override for the target bundle ID (simctl-only).",
    },
  },
  required: ["aps"],
};

interface JsonContext {
  // Path of object keys / array indexes leading from root to the caret.
  path: (string | number)[];
  // What kind of token the caret is currently editing.
  kind: "key" | "value" | "topLevel" | "unknown";
  // Already-typed prefix of the active token (without surrounding quotes).
  prefix: string;
  // Where (in source offset) the active token begins, including any opening
  // quote, so we can replace it cleanly when an autocomplete is accepted.
  tokenStart: number;
  // Whether the active token already started with a quote (so we don't insert
  // a duplicate one when we apply a completion).
  hasOpenQuote: boolean;
  // Source offset of the innermost open `{`, or -1 if at top level. Used to
  // detect siblings already declared in the same object so we don't suggest
  // them again.
  enclosingObjectStart: number;
}

// Walks the source up to `caret` to figure out the JSON path under the caret
// and what kind of completion makes sense. Tolerates partial/invalid JSON
// since the user is typing — we only need the structural skeleton.
function jsonContextAt(source: string, caret: number): JsonContext {
  type Frame =
    | { kind: "object"; key: string | null; start: number }
    | { kind: "array"; index: number; start: number };
  const stack: Frame[] = [];
  let expecting: "key" | "value" | "topLevel" = "topLevel";
  let i = 0;

  while (i < caret) {
    const ch = source[i];
    if (ch === undefined) break;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    if (ch === "{") {
      stack.push({ kind: "object", key: null, start: i });
      expecting = "key";
      i++; continue;
    }
    if (ch === "[") {
      stack.push({ kind: "array", index: 0, start: i });
      expecting = "value";
      i++; continue;
    }
    if (ch === "}") {
      stack.pop();
      const top = stack[stack.length - 1];
      expecting = top ? (top.kind === "array" ? "value" : "key") : "topLevel";
      i++; continue;
    }
    if (ch === "]") {
      stack.pop();
      const top = stack[stack.length - 1];
      expecting = top ? (top.kind === "array" ? "value" : "key") : "topLevel";
      i++; continue;
    }
    if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top && top.kind === "object") { expecting = "key"; top.key = null; }
      else if (top && top.kind === "array") { expecting = "value"; top.index += 1; }
      i++; continue;
    }
    if (ch === ":") {
      expecting = "value";
      i++; continue;
    }
    if (ch === '"') {
      const start = i;
      i++;
      let buf = "";
      let closed = false;
      while (i < caret) {
        const c = source[i];
        if (c === "\\" && i + 1 < caret) { buf += source[i + 1]; i += 2; continue; }
        if (c === '"') { closed = true; i++; break; }
        buf += c;
        i++;
      }
      if (!closed) {
        const top = stack[stack.length - 1];
        const inObject = top?.kind === "object";
        const kind: "key" | "value" = expecting === "key" && inObject ? "key" : "value";
        return {
          path: pathFromStack(stack),
          kind,
          prefix: buf,
          tokenStart: start,
          hasOpenQuote: true,
          enclosingObjectStart: innermostObjectStart(stack),
        };
      }
      const top = stack[stack.length - 1];
      if (expecting === "key" && top && top.kind === "object") {
        top.key = buf;
      }
      continue;
    }
    // Literal (number / true / false / null / partial keyword).
    const litStart = i;
    while (i < caret && !",}]: \t\n\r".includes(source[i] ?? "")) i++;
    if (i === caret) {
      const inObject = stack[stack.length - 1]?.kind === "object";
      const kind: "key" | "value" =
        expecting === "key" && inObject ? "key" : "value";
      return {
        path: pathFromStack(stack),
        kind,
        prefix: source.slice(litStart, caret),
        tokenStart: litStart,
        hasOpenQuote: false,
        enclosingObjectStart: innermostObjectStart(stack),
      };
    }
  }

  const inObject = stack[stack.length - 1]?.kind === "object";
  const kind: "key" | "value" | "topLevel" | "unknown" =
    stack.length === 0 ? "topLevel"
    : expecting === "key" && inObject ? "key"
    : expecting === "value" ? "value"
    : "unknown";
  return {
    path: pathFromStack(stack),
    kind,
    prefix: "",
    tokenStart: caret,
    hasOpenQuote: false,
    enclosingObjectStart: innermostObjectStart(stack),
  };
}

function innermostObjectStart(
  stack: ({ kind: "object"; start: number } | { kind: "array"; start: number })[],
): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i]!;
    if (f.kind === "object") return f.start;
  }
  return -1;
}

function pathFromStack(
  stack: ({ kind: "object"; key: string | null } | { kind: "array"; index: number })[],
): (string | number)[] {
  const path: (string | number)[] = [];
  for (const frame of stack) {
    if (frame.kind === "array") path.push(frame.index);
    else if (frame.key != null) path.push(frame.key);
  }
  return path;
}

function schemaAtPath(schema: JsonSchema | undefined, path: (string | number)[]): JsonSchema | undefined {
  let current: JsonSchema | undefined = schema;
  for (const seg of path) {
    if (!current) return undefined;
    current = resolveSchemaBranch(current, seg);
  }
  return current;
}

function resolveSchemaBranch(schema: JsonSchema, seg: string | number): JsonSchema | undefined {
  const candidates = collectBranches(schema);
  for (const cand of candidates) {
    const c = cand as any;
    if (typeof seg === "string" && c.type === "object" && c.properties && c.properties[seg]) {
      return c.properties[seg];
    }
    if (typeof seg === "number" && c.type === "array" && c.items) {
      return c.items;
    }
  }
  return undefined;
}

function collectBranches(schema: JsonSchema): JsonSchema[] {
  const out: JsonSchema[] = [];
  const s = schema as any;
  if (s.oneOf) for (const b of s.oneOf as JsonSchema[]) out.push(...collectBranches(b));
  if (s.anyOf) for (const b of s.anyOf as JsonSchema[]) out.push(...collectBranches(b));
  if (!s.oneOf && !s.anyOf) out.push(schema);
  return out;
}

interface Suggestion { label: string; insert: string; detail?: string; description?: string }

function suggestionsForContext(schema: JsonSchema, ctx: JsonContext, source: string): Suggestion[] {
  if (ctx.kind === "unknown") return [];
  const target = schemaAtPath(schema, ctx.path);
  if (!target) return [];

  const out: Suggestion[] = [];

  if (ctx.kind === "key") {
    const present = new Set<string>();
    if (ctx.enclosingObjectStart >= 0) {
      const enclosingText = source.slice(ctx.enclosingObjectStart + 1, ctx.tokenStart);
      const re = /"((?:[^"\\]|\\.)*)"\s*:/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(enclosingText))) {
        if (m[1] != null) present.add(m[1]);
      }
    }
    for (const branch of collectBranches(target)) {
      const props = (branch as any).properties as Record<string, JsonSchema> | undefined;
      if (!props) continue;
      for (const [name, propSchema] of Object.entries(props)) {
        if (present.has(name)) continue;
        const insert = ctx.hasOpenQuote ? `${name}"` : `"${name}"`;
        out.push({
          label: name,
          insert,
          detail: schemaTypeLabel(propSchema),
          description: (propSchema as any).description,
        });
      }
    }
  } else if (ctx.kind === "value" || ctx.kind === "topLevel") {
    for (const branch of collectBranches(target)) {
      const b = branch as any;
      if (Array.isArray(b.enum)) {
        for (const v of b.enum) {
          const isString = typeof v === "string";
          const insert = ctx.hasOpenQuote
            ? (isString ? `${String(v)}"` : JSON.stringify(v))
            : JSON.stringify(v);
          out.push({
            label: String(v),
            insert,
            detail: isString ? "string" : typeof v,
          });
        }
      }
      if (b.type === "object" && !ctx.hasOpenQuote && ctx.prefix === "") {
        out.push({ label: "{}", insert: "{}", detail: "object" });
      }
      if (b.type === "array" && !ctx.hasOpenQuote && ctx.prefix === "") {
        out.push({ label: "[]", insert: "[]", detail: "array" });
      }
    }
  }

  const lower = ctx.prefix.toLowerCase();
  const filtered = lower
    ? out.filter((s) => s.label.toLowerCase().includes(lower))
    : out;
  filtered.sort((a, b) => {
    const ap = a.label.toLowerCase().startsWith(lower) ? 0 : 1;
    const bp = b.label.toLowerCase().startsWith(lower) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.label.localeCompare(b.label);
  });
  return filtered;
}

function schemaTypeLabel(schema: JsonSchema): string {
  const branches = collectBranches(schema);
  const names = new Set<string>();
  for (const b of branches) {
    const t = (b as any).type;
    if (typeof t === "string") names.add(t);
  }
  return [...names].join(" | ") || "any";
}

function JsonSchemaEditor({
  value,
  onChange,
  schema,
  placeholder,
  height = 220,
}: {
  value: string;
  onChange: (next: string) => void;
  schema: JsonSchema;
  placeholder?: string;
  height?: number;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [popupPos, setPopupPos] = useState<{ left: number; top: number } | null>(null);

  const ctx = useMemo(() => jsonContextAt(value, caret), [value, caret]);
  const suggestions = useMemo(() => suggestionsForContext(schema, ctx, value), [schema, ctx, value]);

  useEffect(() => {
    if (!open) { setActive(0); return; }
    if (active >= suggestions.length) setActive(0);
  }, [suggestions.length, open, active]);

  const updateCaret = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    setCaret(ta.selectionStart ?? 0);
  }, []);

  // Position the popup by mirroring the textarea content up to the active
  // token and reading the marker span's bounding rect.
  useEffect(() => {
    if (!open) { setPopupPos(null); return; }
    const ta = taRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    const before = value.slice(0, ctx.tokenStart);
    mirror.scrollTop = ta.scrollTop;
    mirror.scrollLeft = ta.scrollLeft;
    mirror.textContent = before;
    const marker = document.createElement("span");
    marker.textContent = "​";
    mirror.appendChild(marker);
    const taRect = ta.getBoundingClientRect();
    const mRect = marker.getBoundingClientRect();
    const left = mRect.left - taRect.left + ta.clientLeft;
    const top = mRect.top - taRect.top + ta.clientTop + mRect.height;
    setPopupPos({ left, top });
  }, [open, value, ctx.tokenStart]);

  const accept = useCallback((s: Suggestion) => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ctx.tokenStart;
    const end = caret;
    const head = value.slice(0, start);
    const tail = value.slice(end);
    let inserted = s.insert;
    let cursorOffset = inserted.length;
    if (ctx.kind === "key") {
      const restTrim = tail.replace(/^\s*/, "");
      if (!restTrim.startsWith(":")) {
        inserted += ": ";
        cursorOffset = inserted.length;
      }
    }
    const next = head + inserted + tail;
    const nextCaret = head.length + cursorOffset;
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  }, [ctx, caret, value, onChange]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (open && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const chosen = suggestions[active];
        if (!chosen) return;
        e.preventDefault();
        accept(chosen);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
    }
    if (e.key === " " && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setOpen(true);
    }
  }, [open, suggestions, active, accept]);

  const onInput = useCallback((e: ReactChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      setCaret(ta.selectionStart ?? 0);
      setOpen(true);
    });
  }, [onChange]);

  return (
    <div className="relative bg-[#0f0f10] border border-white/10 rounded-[7px] overflow-hidden">
      <textarea
        ref={taRef}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={placeholder}
        onChange={onInput}
        onKeyDown={onKeyDown}
        onClick={() => { updateCaret(); setOpen(true); }}
        onSelect={updateCaret}
        onFocus={() => { updateCaret(); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onScroll={() => {
          const ta = taRef.current;
          const mirror = mirrorRef.current;
          if (ta && mirror) {
            mirror.scrollTop = ta.scrollTop;
            mirror.scrollLeft = ta.scrollLeft;
          }
        }}
        className="block w-full bg-transparent border-none outline-none text-white/90 text-[12px] leading-[1.5] font-mono p-2 resize-y [tab-size:2] [caret-color:#6ec8ff] [white-space:pre] overflow-auto box-border"
        style={{ height }}
      />
      <div
        ref={mirrorRef}
        className="absolute top-0 left-0 w-full invisible pointer-events-none text-[12px] leading-[1.5] font-mono p-2 [white-space:pre] overflow-hidden box-border"
        style={{ height }}
        aria-hidden
      />
      {open && suggestions.length > 0 && popupPos && (
        <div
          className="absolute z-30 min-w-[220px] max-w-[320px] bg-[#1c1c1e] border border-white/15 rounded-[8px] shadow-[0_12px_32px_rgba(0,0,0,0.55)] p-1 flex flex-col gap-px max-h-[220px] overflow-y-auto"
          style={{ left: popupPos.left, top: popupPos.top }}
          role="listbox"
          onMouseDown={(e) => e.preventDefault()}
        >
          {suggestions.slice(0, 10).map((s, i) => (
            <button
              key={s.label + i}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`flex items-center justify-between gap-2.5 px-2 py-1 border-none cursor-pointer rounded-[5px] text-left text-[12px] font-mono ${
                i === active ? "bg-[rgba(110,200,255,0.16)] text-white" : "bg-transparent text-white/90"
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => accept(s)}
              title={s.description}
            >
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{s.label}</span>
              {s.detail && (
                <span className="text-[10px] text-white/45 shrink-0 font-mono">{s.detail}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface BundleSuggestion {
  bundleId: string;
  displayName?: string;
  iconDataUrl?: string | null;
  isCurrent?: boolean;
}

export function PushNotificationTool({
  udid,
  currentApp,
}: {
  udid: string;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const [bundleId, setBundleId] = useState("");
  const [bundleManuallySet, setBundleManuallySet] = useState(false);
  const [recents, setRecents] = useState<PushRecent[]>(() =>
    typeof window !== "undefined" ? loadPushRecents() : [],
  );
  const [payload, setPayload] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_PUSH_PAYLOAD;
    return window.localStorage.getItem(PUSH_PAYLOAD_KEY) ?? DEFAULT_PUSH_PAYLOAD;
  });
  const [comboOpen, setComboOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const comboRef = useRef<HTMLDivElement | null>(null);

  // Auto-fill bundle ID from foreground app unless the user has typed their
  // own value in this session.
  useEffect(() => {
    if (bundleManuallySet) return;
    if (!currentApp) return;
    setBundleId(currentApp.bundleId);
  }, [currentApp, bundleManuallySet]);

  // Persist payload draft so refreshes don't drop work-in-progress.
  useEffect(() => {
    try { window.localStorage.setItem(PUSH_PAYLOAD_KEY, payload); } catch {}
  }, [payload]);

  // Fetch icons for the current app + every recent so the dropdown rows aren't
  // empty squares. Cached at the module level so each bundle is fetched once.
  useEffect(() => {
    if (!comboOpen) return;
    const targets = new Set<string>();
    if (currentApp) targets.add(currentApp.bundleId);
    for (const r of recents) targets.add(r.bundleId);
    let cancelled = false;
    for (const bid of targets) {
      if (icons[bid] !== undefined) continue;
      fetchAppIcon(execOnHost, udid, bid).then((url) => {
        if (cancelled) return;
        setIcons((prev) => ({ ...prev, [bid]: url }));
      });
    }
    return () => { cancelled = true; };
  }, [comboOpen, currentApp, recents, icons, udid]);

  useEffect(() => {
    if (!comboOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (!comboRef.current?.contains(e.target as Node)) setComboOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [comboOpen]);

  const jsonError = useMemo(() => {
    if (!payload.trim()) return "Payload is empty";
    try { JSON.parse(payload); return null; }
    catch (e) { return e instanceof Error ? e.message : "Invalid JSON"; }
  }, [payload]);

  const send = useCallback(async () => {
    if (!bundleId.trim() || jsonError || sending) return;
    setSending(true);
    setStatus(null);
    try {
      const compact = JSON.stringify(JSON.parse(payload));
      // Base64 dodges every shell-escaping concern. macOS ships with `base64`
      // and `mktemp`; we clean up the temp file unconditionally.
      const b64 = btoa(unescape(encodeURIComponent(compact)));
      const cmd = `set -e; TMP=$(mktemp -t serve-sim-push); trap 'rm -f "$TMP"' EXIT; printf %s ${shellEscape(b64)} | base64 -d > "$TMP"; xcrun simctl push ${udid} ${shellEscape(bundleId.trim())} "$TMP"`;
      const res = await execOnHost(cmd);
      if (res.exitCode !== 0) {
        setStatus({ kind: "error", message: res.stderr.trim() || `simctl exited ${res.exitCode}` });
        return;
      }
      setStatus({ kind: "success", message: `Delivered to ${bundleId.trim()}` });
      setRecents((prev) => {
        const id = bundleId.trim();
        const carriedName = prev.find((r) => r.bundleId === id)?.displayName;
        const next: PushRecent[] = [
          { bundleId: id, displayName: carriedName, lastUsed: Date.now() },
          ...prev.filter((r) => r.bundleId !== id),
        ].slice(0, PUSH_RECENTS_LIMIT);
        savePushRecents(next);
        return next;
      });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Send failed" });
    } finally {
      setSending(false);
    }
  }, [bundleId, jsonError, sending, payload, udid]);

  const dropdown: BundleSuggestion[] = useMemo(() => {
    const current: BundleSuggestion | null = currentApp
      ? {
          bundleId: currentApp.bundleId,
          iconDataUrl: icons[currentApp.bundleId] ?? null,
          isCurrent: true,
        }
      : null;
    const recentsList = [...recents]
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .filter((r) => r.bundleId !== current?.bundleId)
      .map<BundleSuggestion>((r) => ({
        bundleId: r.bundleId,
        displayName: r.displayName,
        iconDataUrl: icons[r.bundleId] ?? null,
      }));
    return current ? [current, ...recentsList] : recentsList;
  }, [recents, currentApp, icons]);

  const sendDisabled = !bundleId.trim() || !!jsonError || sending;

  return (
    <div className="bg-panel border border-white/8 rounded-[10px] flex flex-col gap-2.5 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="lem-toggle grid [grid-template-columns:auto_1fr_auto] items-center gap-2 bg-transparent border-none text-white/90 py-2.5 px-1 -my-2 -mx-1 cursor-pointer w-[calc(100%+8px)] text-left min-h-[36px] leading-none"
        aria-expanded={open}
      >
        <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">Push Notification</span>
        <span />
        <Chevron open={open} />
      </button>

      {open && (
        <div className="flex flex-col gap-2.5 mt-1">
          {/* Bundle ID combobox */}
          <div ref={comboRef} className="relative">
            <label className="block text-[10px] font-semibold text-white/45 uppercase tracking-[0.06em] mb-1">Target</label>
            <div className="flex items-stretch gap-1 bg-white/[0.04] border border-white/10 rounded-[7px] p-0.5">
              <input
                type="text"
                value={bundleId}
                onChange={(e) => { setBundleId(e.target.value); setBundleManuallySet(true); }}
                onFocus={() => setComboOpen(true)}
                onClick={() => setComboOpen(true)}
                placeholder="com.example.app"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="flex-1 min-w-0 bg-transparent border-none outline-none text-white/90 text-[12px] font-mono px-1.5 py-1"
              />
              {bundleManuallySet && currentApp && currentApp.bundleId !== bundleId && (
                <button
                  type="button"
                  title={`Use foreground app (${currentApp.bundleId})`}
                  onClick={() => { setBundleId(currentApp.bundleId); setBundleManuallySet(false); }}
                  className="self-center bg-transparent border border-white/12 text-white/70 text-[10px] px-1.5 rounded-[5px] cursor-pointer whitespace-nowrap"
                >
                  Use current
                </button>
              )}
              <button
                type="button"
                aria-label="Show recent bundle IDs"
                onClick={() => setComboOpen((o) => !o)}
                className="w-5.5 bg-transparent border-none text-white/50 cursor-pointer flex items-center justify-center rounded p-0"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>
            {comboOpen && dropdown.length > 0 && (
              <div
                className="absolute top-[calc(100%+4px)] left-0 right-0 z-20 bg-[#1c1c1e] border border-white/12 rounded-[8px] shadow-[0_12px_28px_rgba(0,0,0,0.5)] p-1 max-h-[220px] overflow-y-auto flex flex-col gap-px"
                role="listbox"
              >
                {dropdown.map((item) => (
                  <button
                    key={item.bundleId}
                    type="button"
                    role="option"
                    onClick={() => {
                      setBundleId(item.bundleId);
                      setBundleManuallySet(!item.isCurrent);
                      setComboOpen(false);
                    }}
                    className="flex items-center gap-2 p-1.5 bg-transparent border-none text-white/90 cursor-pointer rounded-[5px] text-left w-full min-w-0 hover:bg-white/[0.06]"
                  >
                    {item.iconDataUrl ? (
                      <img src={item.iconDataUrl} alt="" className="w-[22px] h-[22px] rounded-[5px] shrink-0 object-cover border border-white/[0.06]" />
                    ) : (
                      <div className="w-[22px] h-[22px] rounded-[5px] shrink-0 border border-white/[0.06] bg-white/[0.04]" />
                    )}
                    <div className="flex-1 min-w-0 flex flex-col gap-px">
                      <div className="text-[12px] text-white/90 overflow-hidden text-ellipsis whitespace-nowrap flex items-center gap-1.5">
                        {item.displayName ?? item.bundleId}
                        {item.isCurrent && (
                          <span className="text-[9px] text-[#6ec8ff] bg-[#6ec8ff]/12 border border-[#6ec8ff]/25 px-1.5 rounded-full uppercase tracking-[0.05em] font-semibold">
                            foreground
                          </span>
                        )}
                      </div>
                      <div className="text-[10.5px] text-white/45 font-mono overflow-hidden text-ellipsis whitespace-nowrap">
                        {item.bundleId}
                      </div>
                    </div>
                    {!item.isCurrent && (
                      <button
                        type="button"
                        aria-label={`Forget ${item.bundleId}`}
                        title="Remove from recents"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRecents((prev) => {
                            const next = prev.filter((r) => r.bundleId !== item.bundleId);
                            savePushRecents(next);
                            return next;
                          });
                        }}
                        className="w-[18px] h-[18px] bg-transparent border-none text-white/40 cursor-pointer rounded flex items-center justify-center shrink-0 p-0"
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* JSON payload editor */}
          <div className="flex flex-col">
            <div className="flex items-baseline justify-between mb-1">
              <label className="block text-[10px] font-semibold text-white/45 uppercase tracking-[0.06em]">Payload</label>
              <button
                type="button"
                className="bg-transparent border-none text-[#6ec8ff] text-[10px] cursor-pointer p-0 uppercase tracking-[0.05em] font-semibold"
                onClick={() => setPayload(DEFAULT_PUSH_PAYLOAD)}
                title="Reset to a sample alert payload"
              >
                Reset
              </button>
            </div>
            <JsonSchemaEditor
              value={payload}
              onChange={setPayload}
              schema={APNS_PAYLOAD_SCHEMA}
              placeholder='{ "aps": { ... } }'
            />
            {jsonError && (
              <div className="mt-1.5 text-[11px] text-danger-soft font-mono">{jsonError}</div>
            )}
          </div>

          {status && (
            <div
              className={
                status.kind === "success"
                  ? "bg-[#4ade80]/10 border border-[#4ade80]/25 text-[#86efac] text-[11px] px-2 py-1.5 rounded-md"
                  : "bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md font-mono whitespace-pre-wrap break-words"
              }
            >
              {status.message}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-white/40 overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0">
              {ctxHint(jsonError, sending)}
            </span>
            <button
              type="button"
              onClick={send}
              disabled={sendDisabled}
              className="border border-white/18 text-white text-[11px] font-semibold px-3.5 py-1 rounded-md uppercase tracking-[0.05em] bg-[linear-gradient(180deg,#4ea3ff,#2f7fe0)]"
              style={{
                opacity: sendDisabled ? 0.5 : 1,
                cursor: sendDisabled ? "not-allowed" : "pointer",
              }}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ctxHint(jsonError: string | null, sending: boolean): string {
  if (sending) return "simctl push…";
  if (jsonError) return jsonError;
  return "⌃Space for completions";
}
