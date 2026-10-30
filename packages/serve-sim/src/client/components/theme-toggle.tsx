import type { KeyboardEvent } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "../hooks/use-theme";
import type { ThemePreference } from "../utils/theme";

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

// Compact System / Light / Dark segmented control for the web UI appearance.
// (Distinct from the simulator's own appearance in Simulator settings.)
export function ThemeToggle({
  preference: controlledPreference,
  onChange,
  className = "",
}: {
  preference?: ThemePreference;
  onChange?: (preference: ThemePreference) => void;
  className?: string;
}) {
  const theme = useTheme();
  const preference = controlledPreference ?? theme.preference;
  const setPreference = onChange ?? theme.setPreference;

  // Radio-group keyboard model: arrows move (and select) within the group.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = OPTIONS.findIndex((o) => o.value === preference);
    const next = (index + step + OPTIONS.length) % OPTIONS.length;
    setPreference(OPTIONS[next]!.value);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]");
    buttons[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      onKeyDown={onKeyDown}
      className={`flex shrink-0 items-center gap-px rounded-lg bg-ink/6 p-0.5 ${className}`.trim()}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const checked = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            aria-label={label}
            title={`${label} appearance`}
            onClick={() => setPreference(value)}
            className={`grid size-6 cursor-pointer place-items-center rounded-md border-none p-0 [transition:background_0.15s_ease,color_0.15s_ease] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tint ${
              checked
                ? "bg-control-selected text-ink-90 shadow-[0_1px_2px_rgba(0,0,0,0.18)]"
                : "bg-transparent text-icon hover:text-ink-90"
            }`}
          >
            <Icon size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
