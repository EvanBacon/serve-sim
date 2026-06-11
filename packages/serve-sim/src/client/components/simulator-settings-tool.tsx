import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { hostUiRequest } from "../utils/exec";
import { CollapsibleSection } from "./collapsible-section";

// Simulator-wide UI options, mirroring the Xcode Devices app sidebar. Every
// control drives `serve-sim ui <option> <value>`, which handles the simctl-
// native options (appearance, contrast, text size) and the private-setter
// ones (liquid glass, color filter, reduce motion, …) uniformly.

// The slider spans the seven standard content-size categories (the
// accessibility-extended range stays CLI-only); `extra-extra-extra-large` is
// the maximum the control allows.
export const TEXT_SIZE_CATEGORIES = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
] as const;

const TEXT_SIZE_DEBOUNCE_MS = 250;

type SettingsState = Record<string, string>;

// Stock values rendered (disabled) until the real state arrives, so the
// section keeps its full height instead of swapping a "Loading…" line for
// the controls.
const DEFAULT_STATE: SettingsState = {
  appearance: "light",
  "liquid-glass": "clear",
  "color-filter": "none",
  "text-size": "large",
  "reduce-motion": "off",
  "increase-contrast": "off",
  "show-borders": "off",
  "reduce-transparency": "off",
  voiceover: "off",
};

const SELECT_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  appearance: [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ],
  "liquid-glass": [
    { value: "clear", label: "Clear" },
    { value: "tinted", label: "Tinted" },
  ],
  "color-filter": [
    { value: "none", label: "None" },
    { value: "red-green", label: "Red/Green (Protanopia)" },
    { value: "green-red", label: "Green/Red (Deuteranopia)" },
    { value: "blue-yellow", label: "Blue/Yellow (Tritanopia)" },
    { value: "grayscale", label: "Grayscale" },
  ],
};

const TOGGLE_OPTIONS = [
  { key: "reduce-motion", label: "Reduce Motion" },
  { key: "increase-contrast", label: "Increase Contrast" },
  { key: "show-borders", label: "Show Borders" },
  { key: "reduce-transparency", label: "Reduce Transparency" },
  { key: "voiceover", label: "VoiceOver" },
] as const;

function SettingRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 min-h-[30px]" data-setting-row={label}>
      <span className="flex shrink-0 items-center gap-2 text-[12px] text-white/90 whitespace-nowrap">
        <span className="flex size-[18px] items-center justify-center text-white">{icon}</span>
        {label}
      </span>
      {/* min-w-0 lets the control shrink instead of overflowing the panel
          when it's resized to its narrow end. */}
      <span className="flex min-w-0 justify-end">{children}</span>
    </div>
  );
}

function SettingSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full border-none p-0 [transition:background_0.15s] ${
        disabled
          ? "cursor-default bg-white/20"
          : checked
            ? "cursor-pointer bg-[#0a84ff]"
            : "cursor-pointer bg-white/20"
      }`}
    >
      <span
        className={`absolute top-[2px] size-[14px] rounded-full [transition:left_0.15s] ${disabled ? "bg-white/50" : "bg-white"}`}
        style={{ left: checked ? 16 : 2 }}
      />
    </button>
  );
}

function TextSizeSlider({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (index: number) => void;
}) {
  // Local value while dragging so prop round-trips can't interrupt the
  // gesture. Changes apply live but debounced; release flushes immediately.
  const [drag, setDrag] = useState<number | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef<number | null>(null);

  const send = useCallback(
    (index: number) => {
      if (lastSent.current === index) return;
      lastSent.current = index;
      onChange(index);
    },
    [onChange],
  );

  const handleInput = useCallback(
    (index: number) => {
      setDrag(index);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => send(index), TEXT_SIZE_DEBOUNCE_MS);
    },
    [send],
  );

  const flush = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    setDrag((d) => {
      if (d !== null) send(d);
      return null;
    });
    lastSent.current = null;
  }, [send]);

  const max = TEXT_SIZE_CATEGORIES.length - 1;
  const shown = drag ?? value;
  const fill = `${(shown / max) * 100}%`;
  // Filled portion goes gray while disabled so the control doesn't read as
  // live during hydration.
  const fillColor = disabled ? "rgba(255,255,255,0.3)" : "#0a84ff";

  const trackClasses =
    "[&::-webkit-slider-runnable-track]:h-[4px] [&::-webkit-slider-runnable-track]:rounded-full " +
    "[&::-webkit-slider-runnable-track]:[background:linear-gradient(to_right,var(--slider-fill-color)_var(--slider-fill),rgba(255,255,255,0.22)_var(--slider-fill))] " +
    "[&::-moz-range-track]:h-[4px] [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-white/20 " +
    "[&::-moz-range-progress]:h-[4px] [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-[var(--slider-fill-color)]";
  const thumbClasses =
    "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:size-[13px] [&::-webkit-slider-thumb]:rounded-full " +
    "[&::-webkit-slider-thumb]:bg-white [&:disabled::-webkit-slider-thumb]:bg-white/50 " +
    "[&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(0,0,0,0.45)] [&::-webkit-slider-thumb]:-mt-[4.5px] " +
    "[&::-moz-range-thumb]:size-[13px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-none " +
    "[&::-moz-range-thumb]:bg-white [&:disabled::-moz-range-thumb]:bg-white/50";

  return (
    <span className="flex w-[120px] min-w-0 flex-col">
      <input
        type="range"
        aria-label="Text Size"
        min={0}
        max={max}
        step={1}
        value={shown}
        disabled={disabled}
        onChange={(e) => handleInput(Number((e.target as HTMLInputElement).value))}
        onPointerUp={flush}
        onKeyUp={flush}
        onBlur={flush}
        style={{ "--slider-fill": fill, "--slider-fill-color": fillColor } as CSSProperties}
        className={`h-[13px] w-full appearance-none rounded-full bg-transparent outline-none focus-visible:[outline:1.5px_solid_rgba(10,132,255,0.55)] focus-visible:outline-offset-4 ${disabled ? "cursor-default" : "cursor-pointer"} ${trackClasses} ${thumbClasses}`}
      />
      <span aria-hidden className="pointer-events-none mt-[3px] flex justify-between px-[5.5px]">
        {TEXT_SIZE_CATEGORIES.map((category) => (
          <span key={category} className="size-[2px] rounded-full bg-white/40" />
        ))}
      </span>
    </span>
  );
}

function SettingSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
      className="appearance-none [-webkit-appearance:none] bg-white/[0.06] border border-white/10 rounded-md text-white/90 text-[12px] py-0.5 px-2 font-[inherit] cursor-pointer min-w-0 max-w-[150px] truncate disabled:cursor-default disabled:text-white/40"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// Inline 14px glyphs, stroked at full opacity (no dimmed icons).
const I = {
  appearance: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
  ),
  glass: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="5" width="18" height="14" rx="4" />
      <rect x="7" y="9" width="10" height="6" rx="3" fill="currentColor" stroke="none" />
    </svg>
  ),
  filter: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="9" cy="12" r="6" />
      <circle cx="15" cy="12" r="6" />
    </svg>
  ),
  textSize: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 18V8m0 0h4M4 8H2.5" />
      <path d="M13 18V5m0 0h5.5M13 5H8" />
    </svg>
  ),
  motion: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="14" cy="12" r="6" />
      <path d="M3 8h4M2 12h4M3 16h4" />
    </svg>
  ),
  contrast: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18A9 9 0 0 0 12 3z" fill="currentColor" stroke="none" />
    </svg>
  ),
  borders: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="4" strokeDasharray="4 3" />
      <rect x="8" y="8" width="8" height="8" rx="2" />
    </svg>
  ),
  transparency: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="13" height="13" rx="3" />
      <rect x="8" y="8" width="13" height="13" rx="3" />
    </svg>
  ),
  voiceover: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 15l3-7 3 7m-5-2h4" />
    </svg>
  ),
};

export function SimulatorSettingsTool({ udid }: { udid: string }) {
  const [open, setOpen] = useState(true);
  const [state, setState] = useState<SettingsState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydration can fail outright (server restarted under the tab, control
  // socket unreachable) or stall — both must land in the error state with a
  // Retry, never an eternal disabled section.
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const status = await hostUiRequest(
        { device: udid },
        { signal: AbortSignal.timeout(15_000) },
      );
      if (status) setState(status);
      else setError("Unexpected simulator-settings reply");
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "TimeoutError"
          ? "Timed out reading simulator settings"
          : e instanceof Error && e.message !== "Failed to fetch"
            ? e.message
            : "Could not reach the preview server — reload the page if this persists",
      );
    }
  }, [udid]);

  useEffect(() => {
    setState(null);
    void refresh();
  }, [refresh]);

  const apply = useCallback(
    async (option: string, value: string) => {
      setPending(option);
      setError(null);
      setState((s) => (s ? { ...s, [option]: value } : s));
      try {
        await hostUiRequest(
          { device: udid, option, value },
          { signal: AbortSignal.timeout(15_000) },
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to set ${option}`);
        // Re-sync from the simulator rather than restoring a snapshot — with
        // rapid queued updates (slider drags) a snapshot can predate several
        // successful sets and would yank the control backwards.
        void refresh();
      } finally {
        setPending(null);
      }
    },
    [udid, refresh],
  );

  // Rapid slider movements queue latest-wins: one exec in flight at a time,
  // intermediate values dropped, so out-of-order completions can't leave the
  // simulator on a stale size.
  const textSizeQueue = useRef<{ running: boolean; next: number | null }>({
    running: false,
    next: null,
  });
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const applyTextSize = useCallback((index: number) => {
    const queue = textSizeQueue.current;
    queue.next = index;
    if (queue.running) return;
    queue.running = true;
    void (async () => {
      while (queue.next !== null) {
        const next = queue.next;
        queue.next = null;
        await applyRef.current("text-size", TEXT_SIZE_CATEGORIES[next]!);
      }
      queue.running = false;
    })();
  }, []);

  const ready = state !== null;
  const shown = state ?? DEFAULT_STATE;
  const rawTextSizeIndex = TEXT_SIZE_CATEGORIES.indexOf(shown["text-size"] as never);
  // CLI-set accessibility-range sizes exceed the slider; pin them to its max.
  const textSizeIndex =
    rawTextSizeIndex >= 0
      ? rawTextSizeIndex
      : shown["text-size"]?.startsWith("accessibility")
        ? TEXT_SIZE_CATEGORIES.length - 1
        : 3;

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      data-simulator-settings=""
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Simulator
          </span>
          <span />
        </>
      }
    >
      {error && (
        <div className="bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md flex items-center justify-between gap-2">
          <span className="min-w-0">{error}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 cursor-pointer rounded border border-danger/30 bg-transparent px-1.5 py-0.5 text-[11px] text-danger-soft"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex flex-col gap-1.5 pb-1.5">
          <SettingRow icon={I.appearance} label="Appearance">
            <SettingSelect
              label="Appearance"
              value={shown.appearance ?? "light"}
              options={SELECT_OPTIONS.appearance!}
              disabled={!ready || pending === "appearance"}
              onChange={(v) => apply("appearance", v)}
            />
          </SettingRow>

          <SettingRow icon={I.glass} label="Liquid Glass">
            <SettingSelect
              label="Liquid Glass"
              value={shown["liquid-glass"] ?? "clear"}
              options={SELECT_OPTIONS["liquid-glass"]!}
              disabled={!ready || pending === "liquid-glass"}
              onChange={(v) => apply("liquid-glass", v)}
            />
          </SettingRow>

          <SettingRow icon={I.filter} label="Color Filter">
            <SettingSelect
              label="Color Filter"
              value={shown["color-filter"] ?? "none"}
              options={SELECT_OPTIONS["color-filter"]!}
              disabled={!ready || pending === "color-filter"}
              onChange={(v) => apply("color-filter", v)}
            />
          </SettingRow>

          <SettingRow icon={I.textSize} label="Text Size">
            <TextSizeSlider
              value={textSizeIndex}
              disabled={!ready}
              onChange={applyTextSize}
            />
          </SettingRow>

          {TOGGLE_OPTIONS.map(({ key, label }) => (
            <SettingRow
              key={key}
              icon={I[
                key === "reduce-motion"
                  ? "motion"
                  : key === "increase-contrast"
                    ? "contrast"
                    : key === "show-borders"
                      ? "borders"
                      : key === "reduce-transparency"
                        ? "transparency"
                        : "voiceover"
              ]}
              label={label}
            >
              <SettingSwitch
                label={label}
                checked={shown[key] === "on"}
                disabled={!ready || pending === key}
                onChange={(next) => apply(key, next ? "on" : "off")}
              />
            </SettingRow>
          ))}
        </div>
    </CollapsibleSection>
  );
}
