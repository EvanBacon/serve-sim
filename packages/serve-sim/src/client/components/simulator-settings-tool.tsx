import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { hostUiRequest } from "../utils/exec";
import { parseRuntime } from "../utils/grid";
import { CollapsibleSection } from "./collapsible-section";
import { Select } from "./select";
import { SettingSwitch } from "./setting-switch";

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

export function SettingRow({
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

export function SettingSelect({
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
    <Select
      label={label}
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
      className="bg-white/[0.06] border border-white/10 rounded-md text-white/90 text-[12px] py-0.5 px-2 min-w-0 max-w-[150px] disabled:text-white/40"
    />
  );
}

// Inline 14px glyphs, stroked at full opacity (no dimmed icons).
const I = {
  appearance: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v2" />
      <path d="M14.837 16.385a6 6 0 1 1-7.223-7.222c.624-.147.97.66.715 1.248a4 4 0 0 0 5.26 5.259c.589-.255 1.396.09 1.248.715" />
      <path d="M16 12a4 4 0 0 0-4-4" />
      <path d="m19 5-1.256 1.256" />
      <path d="M20 12h2" />
    </svg>
  ),
  glass: (
    <svg width="14" height="14" viewBox="0 0 220 220" fill="currentColor" stroke="none">
      <path d="M152 183V195H100V183H152ZM196 139V126C196 101.699 176.301 82 152 82H100C75.6995 82 56 101.699 56 126V139C56 163.301 75.6995 183 100 183V195L99.2764 194.995C68.9228 194.611 44.3893 170.077 44.0049 139.724L44 139V126C44 95.0721 69.0721 70 100 70H152C182.928 70 208 95.0721 208 126V139L207.995 139.724C207.611 170.077 183.077 194.611 152.724 194.995L152 195V183C176.301 183 196 163.301 196 139Z" />
      <path d="M136 25C147.046 25 156 33.9543 156 45V70H143V45C143 41.134 139.866 38 136 38H41C37.134 38 34 41.134 34 45V140C34 143.866 37.134 147 41 147H44.8604C45.6487 151.536 46.9634 155.891 48.7402 160H41L40.4834 159.993C29.8481 159.724 21.2765 151.152 21.0068 140.517L21 140V45C21 33.9543 29.9543 25 41 25H136Z" />
      <path d="M156.199 140C156.199 150.873 147.523 159.719 136.716 159.993L136.199 160H80.917C77.9461 160 76.1639 163.3 77.793 165.784C79.2451 167.999 76.1647 170.353 74.4094 168.37L73.6059 167.462C69.3497 162.654 67 156.455 67 150.034C67 148.358 68.3583 147 70.0339 147H136.199C140.065 147 143.199 143.866 143.199 140V96.9955C143.199 93.9822 141.354 91.2763 138.549 90.1761C137.389 89.7215 137.715 88 138.96 88L143.199 88C150.379 88 156.199 93.8203 156.199 101V140Z" />
    </svg>
  ),
  filter: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 17a4 4 0 0 1-8 0V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2Z" />
      <path d="M16.7 13H19a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7" />
      <path d="M 7 17h.01" />
      <path d="m11 8 2.3-2.3a2.4 2.4 0 0 1 3.404.004L18.6 7.6a2.4 2.4 0 0 1 .026 3.434L9.9 19.8" />
    </svg>
  ),
  textSize: (
    <svg width="14" height="14" viewBox="0 0 52 34" fill="currentColor" stroke="none">
      <path d="M39.7266 33.0234C38.1484 33.0234 36.75 32.7266 35.5312 32.1328C34.3125 31.5391 33.3594 30.7109 32.6719 29.6484C32 28.5703 31.6641 27.3125 31.6641 25.875C31.6641 23.7812 32.4297 22.1094 33.9609 20.8594C35.5078 19.6094 37.7109 18.9062 40.5703 18.75L47.6016 18.3516V16.5C47.6016 15.0156 47.1328 13.8359 46.1953 12.9609C45.2578 12.0859 43.9531 11.6484 42.2812 11.6484C40.9062 11.6484 39.75 11.9453 38.8125 12.5391C37.875 13.1328 37.0938 14.0469 36.4688 15.2812C36.2656 15.6094 36.0156 15.8516 35.7188 16.0078C35.4219 16.1641 35.0781 16.2422 34.6875 16.2422C34.1562 16.2422 33.7109 16.0781 33.3516 15.75C33.0078 15.4219 32.8359 14.9922 32.8359 14.4609C32.8359 14.2266 32.8672 13.9766 32.9297 13.7109C33.0078 13.4453 33.1094 13.1797 33.2344 12.9141C33.875 11.4609 35.0156 10.3047 36.6562 9.44531C38.3125 8.58594 40.2266 8.15625 42.3984 8.15625C44.3203 8.15625 45.9844 8.49219 47.3906 9.16406C48.8125 9.82031 49.8984 10.75 50.6484 11.9531C51.4141 13.1562 51.7969 14.5703 51.7969 16.1953V30.9141C51.7969 31.5859 51.6094 32.1094 51.2344 32.4844C50.8594 32.8594 50.3672 33.0469 49.7578 33.0469C49.1641 33.0469 48.6797 32.8672 48.3047 32.5078C47.9297 32.1484 47.7344 31.6641 47.7188 31.0547V28.3594H47.6719C46.9844 29.7812 45.9062 30.9141 44.4375 31.7578C42.9844 32.6016 41.4141 33.0234 39.7266 33.0234ZM40.8047 29.6719C42.0703 29.6719 43.2109 29.4062 44.2266 28.875C45.2578 28.3438 46.0781 27.6172 46.6875 26.6953C47.2969 25.7734 47.6016 24.75 47.6016 23.625V21.3281L41.1328 21.75C39.4453 21.8594 38.1641 22.2734 37.2891 22.9922C36.4141 23.6953 35.9766 24.6094 35.9766 25.7344C35.9766 26.9219 36.4219 27.875 37.3125 28.5938C38.2031 29.3125 39.3672 29.6719 40.8047 29.6719ZM2.17969 33.0234C1.50781 33.0234 0.976562 32.8359 0.585938 32.4609C0.195312 32.0859 0 31.5781 0 30.9375C0 30.5312 0.0859375 30.0703 0.257812 29.5547L10.4062 2.41406C10.9844 0.804688 12.1016 0 13.7578 0C14.6172 0 15.3281 0.203125 15.8906 0.609375C16.4531 1.01562 16.875 1.625 17.1562 2.4375L27.2578 29.4844C27.4453 30 27.5391 30.4688 27.5391 30.8906C27.5391 31.5469 27.3359 32.0703 26.9297 32.4609C26.5234 32.8359 25.9766 33.0234 25.2891 33.0234C24.6328 33.0234 24.1094 32.875 23.7188 32.5781C23.3438 32.2812 23.0391 31.7891 22.8047 31.1016L13.8281 5.34375H13.6641L4.66406 31.1016C4.42969 31.7891 4.125 32.2812 3.75 32.5781C3.375 32.875 2.85156 33.0234 2.17969 33.0234ZM6.67969 23.7422C6.14844 23.7422 5.70312 23.5625 5.34375 23.2031C4.98438 22.8438 4.80469 22.3984 4.80469 21.8672C4.80469 21.3516 4.98438 20.9141 5.34375 20.5547C5.70312 20.1953 6.14844 20.0156 6.67969 20.0156H20.8594C21.375 20.0156 21.8125 20.1953 22.1719 20.5547C22.5312 20.9141 22.7109 21.3516 22.7109 21.8672C22.7109 22.3984 22.5312 22.8438 22.1719 23.2031C21.8125 23.5625 21.375 23.7422 20.8594 23.7422H6.67969Z" />
    </svg>
  ),
  motion: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="14" cy="12" r="6" />
      <path d="M3 8h4M2 12h4M3 16h4" />
    </svg>
  ),
  contrast: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 18a6 6 0 0 0 0-12v12z" />
    </svg>
  ),
  borders: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2" />
      <path d="M9 21h1" />
      <path d="M14 21h1" />
    </svg>
  ),
  transparency: (
    <svg width="14" height="14" viewBox="0 0 63 46" fill="currentColor" stroke="none">
      <path d="M22.7344 4.17188C22.1875 4.17188 21.7188 3.97656 21.3281 3.58594C20.9375 3.19531 20.7422 2.71875 20.7422 2.15625C20.7422 1.60938 20.9375 1.14062 21.3281 0.75C21.7188 0.359375 22.1875 0.164062 22.7344 0.164062C23.2812 0.164062 23.75 0.359375 24.1406 0.75C24.5312 1.14062 24.7266 1.60938 24.7266 2.15625C24.7266 2.71875 24.5312 3.19531 24.1406 3.58594C23.75 3.97656 23.2812 4.17188 22.7344 4.17188ZM29.1094 5.20312C28.5469 5.20312 28.0703 5.00781 27.6797 4.61719C27.2891 4.22656 27.0938 3.75781 27.0938 3.21094C27.0938 2.66406 27.2891 2.19531 27.6797 1.80469C28.0703 1.39844 28.5469 1.19531 29.1094 1.19531C29.6562 1.19531 30.125 1.39844 30.5156 1.80469C30.9062 2.19531 31.1016 2.66406 31.1016 3.21094C31.1016 3.75781 30.9062 4.22656 30.5156 4.61719C30.125 5.00781 29.6562 5.20312 29.1094 5.20312ZM34.875 8.13281C34.3281 8.13281 33.8516 7.9375 33.4453 7.54688C33.0547 7.14062 32.8594 6.67188 32.8594 6.14062C32.8594 5.57812 33.0547 5.10156 33.4453 4.71094C33.8516 4.32031 34.3281 4.125 34.875 4.125C35.4219 4.125 35.8906 4.32031 36.2812 4.71094C36.6875 5.10156 36.8906 5.57812 36.8906 6.14062C36.8906 6.67188 36.6875 7.14062 36.2812 7.54688C35.8906 7.9375 35.4219 8.13281 34.875 8.13281ZM39.4453 12.6797C38.8984 12.6797 38.4219 12.4844 38.0156 12.0938C37.625 11.7031 37.4297 11.2344 37.4297 10.6875C37.4297 10.1562 37.625 9.69531 38.0156 9.30469C38.4219 8.89844 38.8984 8.69531 39.4453 8.69531C39.9922 8.69531 40.4609 8.89844 40.8516 9.30469C41.2422 9.69531 41.4375 10.1562 41.4375 10.6875C41.4375 11.2344 41.2422 11.7031 40.8516 12.0938C40.4609 12.4844 39.9922 12.6797 39.4453 12.6797ZM42.375 18.3984C41.8125 18.3984 41.3281 18.2031 40.9219 17.8125C40.5312 17.4219 40.3359 16.9531 40.3359 16.4062C40.3359 15.8438 40.5312 15.3672 40.9219 14.9766C41.3281 14.5859 41.8125 14.3906 42.375 14.3906C42.9062 14.3906 43.3672 14.5859 43.7578 14.9766C44.1641 15.3672 44.3672 15.8438 44.3672 16.4062C44.3672 16.9531 44.1641 17.4219 43.7578 17.8125C43.3672 18.2031 42.9062 18.3984 42.375 18.3984ZM43.4531 24.7969C42.9062 24.7969 42.4375 24.6016 42.0469 24.2109C41.6562 23.8203 41.4609 23.3438 41.4609 22.7812C41.4609 22.2344 41.6562 21.7656 42.0469 21.375C42.4375 20.9844 42.9062 20.7891 43.4531 20.7891C44 20.7891 44.4688 20.9844 44.8594 21.375C45.2656 21.7656 45.4688 22.2344 45.4688 22.7812C45.4688 23.3438 45.2656 23.8203 44.8594 24.2109C44.4688 24.6016 44 24.7969 43.4531 24.7969ZM42.375 31.1719C41.8125 31.1719 41.3281 30.9766 40.9219 30.5859C40.5312 30.1953 40.3359 29.7266 40.3359 29.1797C40.3359 28.6172 40.5312 28.1406 40.9219 27.75C41.3281 27.3594 41.8125 27.1641 42.375 27.1641C42.9062 27.1641 43.3672 27.3594 43.7578 27.75C44.1641 28.1406 44.3672 28.6172 44.3672 29.1797C44.3672 29.7266 44.1641 30.1953 43.7578 30.5859C43.3672 30.9766 42.9062 31.1719 42.375 31.1719ZM39.4453 36.8906C38.8984 36.8906 38.4219 36.6953 38.0156 36.3047C37.625 35.8984 37.4297 35.4219 37.4297 34.875C37.4297 34.3281 37.625 33.8594 38.0156 33.4688C38.4219 33.0625 38.8984 32.8594 39.4453 32.8594C39.9922 32.8594 40.4609 33.0625 40.8516 33.4688C41.2422 33.8594 41.4375 34.3281 41.4375 34.875C41.4375 35.4219 41.2422 35.8984 40.8516 36.3047C40.4609 36.6953 39.9922 36.8906 39.4453 36.8906ZM34.875 41.4375C34.3281 41.4375 33.8516 41.2422 33.4453 40.8516C33.0547 40.4609 32.8594 39.9922 32.8594 39.4453C32.8594 38.8984 33.0547 38.4297 33.4453 38.0391C33.8516 37.6328 34.3281 37.4297 34.875 37.4297C35.4219 37.4297 35.8906 37.6328 36.2812 38.0391C36.6875 38.4297 36.8906 38.8984 36.8906 39.4453C36.8906 39.9922 36.6875 40.4609 36.2812 40.8516C35.8906 41.2422 35.4219 41.4375 34.875 41.4375ZM29.1094 44.3672C28.5469 44.3672 28.0703 44.1641 27.6797 43.7578C27.2891 43.3672 27.0938 42.8984 27.0938 42.3516C27.0938 41.8047 27.2891 41.3359 27.6797 40.9453C28.0703 40.5547 28.5469 40.3594 29.1094 40.3594C29.6562 40.3594 30.125 40.5547 30.5156 40.9453C30.9062 41.3359 31.1016 41.8047 31.1016 42.3516C31.1016 42.8984 30.9062 43.3672 30.5156 43.7578C30.125 44.1641 29.6562 44.3672 29.1094 44.3672ZM22.7344 45.3984C22.1875 45.3984 21.7188 45.2031 21.3281 44.8125C20.9375 44.4219 20.7422 43.9531 20.7422 43.4062C20.7422 42.8438 20.9375 42.3672 21.3281 41.9766C21.7188 41.5859 22.1875 41.3906 22.7344 41.3906C23.2812 41.3906 23.75 41.5859 24.1406 41.9766C24.5312 42.3672 24.7266 42.8438 24.7266 43.4062C24.7266 43.9531 24.5312 44.4219 24.1406 44.8125C23.75 45.2031 23.2812 45.3984 22.7344 45.3984ZM16.3594 44.3672C15.8125 44.3672 15.3438 44.1641 14.9531 43.7578C14.5625 43.3672 14.3672 42.8984 14.3672 42.3516C14.3672 41.8047 14.5625 41.3359 14.9531 40.9453C15.3438 40.5547 15.8125 40.3594 16.3594 40.3594C16.9219 40.3594 17.3984 40.5547 17.7891 40.9453C18.1797 41.3359 18.375 41.8047 18.375 42.3516C18.375 42.8984 18.1797 43.3672 17.7891 43.7578C17.3984 44.1641 16.9219 44.3672 16.3594 44.3672ZM10.5703 41.4375C10.0391 41.4375 9.57031 41.2422 9.16406 40.8516C8.77344 40.4609 8.57812 39.9922 8.57812 39.4453C8.57812 38.8984 8.77344 38.4297 9.16406 38.0391C9.57031 37.6328 10.0391 37.4297 10.5703 37.4297C11.1328 37.4297 11.6094 37.6328 12 38.0391C12.3906 38.4297 12.5859 38.8984 12.5859 39.4453C12.5859 39.9922 12.3906 40.4609 12 40.8516C11.6094 41.2422 11.1328 41.4375 10.5703 41.4375ZM6.02344 36.8906C5.47656 36.8906 5 36.6953 4.59375 36.3047C4.20312 35.8984 4.00781 35.4219 4.00781 34.875C4.00781 34.3281 4.20312 33.8594 4.59375 33.4688C5 33.0625 5.47656 32.8594 6.02344 32.8594C6.57031 32.8594 7.03906 33.0625 7.42969 33.4688C7.82031 33.8594 8.01562 34.3281 8.01562 34.875C8.01562 35.4219 7.82031 35.8984 7.42969 36.3047C7.03906 36.6953 6.57031 36.8906 6.02344 36.8906ZM3.09375 31.1719C2.5625 31.1719 2.09375 30.9766 1.6875 30.5859C1.29688 30.1953 1.10156 29.7266 1.10156 29.1797C1.10156 28.6172 1.29688 28.1406 1.6875 27.75C2.09375 27.3594 2.5625 27.1641 3.09375 27.1641C3.65625 27.1641 4.13281 27.3594 4.52344 27.75C4.91406 28.1406 5.10938 28.6172 5.10938 29.1797C5.10938 29.7266 4.91406 30.1953 4.52344 30.5859C4.13281 30.9766 3.65625 31.1719 3.09375 31.1719ZM2.01562 24.7969C1.45312 24.7969 0.976562 24.6016 0.585938 24.2109C0.195312 23.8203 0 23.3438 0 22.7812C0 22.2344 0.195312 21.7656 0.585938 21.375C0.976562 20.9844 1.45312 20.7891 2.01562 20.7891C2.5625 20.7891 3.03125 20.9844 3.42188 21.375C3.8125 21.7656 4.00781 22.2344 4.00781 22.7812C4.00781 23.3438 3.8125 23.8203 3.42188 24.2109C3.03125 24.6016 2.5625 24.7969 2.01562 24.7969ZM3.09375 18.3984C2.5625 18.3984 2.09375 18.2031 1.6875 17.8125C1.29688 17.4219 1.10156 16.9531 1.10156 16.4062C1.10156 15.8438 1.29688 15.3672 1.6875 14.9766C2.09375 14.5859 2.5625 14.3906 3.09375 14.3906C3.65625 14.3906 4.13281 14.5859 4.52344 14.9766C4.91406 15.3672 5.10938 15.8438 5.10938 16.4062C5.10938 16.9531 4.91406 17.4219 4.52344 17.8125C4.13281 18.2031 3.65625 18.3984 3.09375 18.3984ZM6.02344 12.6797C5.47656 12.6797 5 12.4844 4.59375 12.0938C4.20312 11.7031 4.00781 11.2344 4.00781 10.6875C4.00781 10.1562 4.20312 9.69531 4.59375 9.30469C5 8.89844 5.47656 8.69531 6.02344 8.69531C6.57031 8.69531 7.03906 8.89844 7.42969 9.30469C7.82031 9.69531 8.01562 10.1562 8.01562 10.6875C8.01562 11.2344 7.82031 11.7031 7.42969 12.0938C7.03906 12.4844 6.57031 12.6797 6.02344 12.6797ZM10.5703 8.13281C10.0391 8.13281 9.57031 7.9375 9.16406 7.54688C8.77344 7.14062 8.57812 6.67188 8.57812 6.14062C8.57812 5.57812 8.77344 5.10156 9.16406 4.71094C9.57031 4.32031 10.0391 4.125 10.5703 4.125C11.1328 4.125 11.6094 4.32031 12 4.71094C12.3906 5.10156 12.5859 5.57812 12.5859 6.14062C12.5859 6.67188 12.3906 7.14062 12 7.54688C11.6094 7.9375 11.1328 8.13281 10.5703 8.13281ZM16.3594 5.20312C15.8125 5.20312 15.3438 5.00781 14.9531 4.61719C14.5625 4.22656 14.3672 3.75781 14.3672 3.21094C14.3672 2.66406 14.5625 2.19531 14.9531 1.80469C15.3438 1.39844 15.8125 1.19531 16.3594 1.19531C16.9219 1.19531 17.3984 1.39844 17.7891 1.80469C18.1797 2.19531 18.375 2.66406 18.375 3.21094C18.375 3.75781 18.1797 4.22656 17.7891 4.61719C17.3984 5.00781 16.9219 5.20312 16.3594 5.20312ZM40.1016 45.5625C36.9453 45.5625 33.9922 44.9688 31.2422 43.7812C28.5078 42.6094 26.0938 40.9766 24 38.8828C21.9062 36.7891 20.2656 34.3672 19.0781 31.6172C17.9062 28.8672 17.3203 25.9219 17.3203 22.7812C17.3203 19.6406 17.9062 16.6953 19.0781 13.9453C20.2656 11.1797 21.9062 8.75781 24 6.67969C26.0938 4.58594 28.5078 2.95312 31.2422 1.78125C33.9922 0.59375 36.9453 0 40.1016 0C43.2422 0 46.1875 0.59375 48.9375 1.78125C51.6875 2.95312 54.1016 4.58594 56.1797 6.67969C58.2734 8.75781 59.9062 11.1797 61.0781 13.9453C62.2656 16.6953 62.8594 19.6406 62.8594 22.7812C62.8594 25.9219 62.2656 28.8672 61.0781 31.6172C59.9062 34.3672 58.2734 36.7891 56.1797 38.8828C54.1016 40.9766 51.6875 42.6094 48.9375 43.7812C46.1875 44.9688 43.2422 45.5625 40.1016 45.5625ZM40.1016 41.3906C42.6641 41.3906 45.0703 40.9062 47.3203 39.9375C49.5703 38.9688 51.5469 37.6328 53.25 35.9297C54.9688 34.2266 56.3047 32.2578 57.2578 30.0234C58.2109 27.7734 58.6875 25.3594 58.6875 22.7812C58.6875 20.2031 58.2109 17.7969 57.2578 15.5625C56.3047 13.3125 54.9688 11.3359 53.25 9.63281C51.5469 7.92969 49.5703 6.59375 47.3203 5.625C45.0703 4.65625 42.6641 4.17188 40.1016 4.17188C37.5234 4.17188 35.1094 4.65625 32.8594 5.625C30.625 6.59375 28.6484 7.92969 26.9297 9.63281C25.2266 11.3359 23.8906 13.3125 22.9219 15.5625C21.9688 17.7969 21.4922 20.2031 21.4922 22.7812C21.4922 25.3594 21.9688 27.7734 22.9219 30.0234C23.8906 32.2578 25.2266 34.2266 26.9297 35.9297C28.6484 37.6328 30.625 38.9688 32.8594 39.9375C35.1094 40.9062 37.5234 41.3906 40.1016 41.3906Z" />
    </svg>
  ),
  voiceover: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12" />
      <path d="M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5" />
      <circle cx="16" cy="7" r="5" />
    </svg>
  ),
};

// These options drive the iOS accessibility/appearance setters; the in-sim
// helper is an iOS-simulator binary, so the panel only applies to iOS devices.
// (`runtime` arrives as `iOS-26-5` / `watchOS-11-2` — simctl's SimRuntime
// suffix.) Treat an unknown runtime as iOS so the panel still renders.
export function isIosRuntime(runtime: string | null): boolean {
  if (!runtime) return true;
  return parseRuntime(runtime).os.toLowerCase() === "ios";
}

export function SimulatorSettingsTool({
  udid,
  runtime,
}: {
  udid: string;
  runtime: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [state, setState] = useState<SettingsState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = isIosRuntime(runtime);

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
    // The in-sim helper can't run on non-iOS runtimes; skip the round-trip
    // (it would spawn an iOS binary inside e.g. a watchOS sim and abort).
    if (!supported) return;
    void refresh();
  }, [refresh, supported]);

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
      {!supported ? (
        <div className="text-white/45 text-[11px] px-0.5 py-1">
          Simulator settings are available on iOS simulators only.
        </div>
      ) : (
        <>
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
        </>
      )}
    </CollapsibleSection>
  );
}
