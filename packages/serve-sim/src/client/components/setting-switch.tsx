// iOS-style toggle switch shared across the settings sidebar and tool panels.
export function SettingSwitch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
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
          ? "cursor-default bg-ink/20"
          : checked
            ? "cursor-pointer bg-tint"
            : "cursor-pointer bg-ink/20"
      }`}
    >
      <span
        className={`absolute top-[2px] size-[14px] rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.2)] [transition:left_0.15s] ${disabled ? "bg-white/50" : "bg-white"}`}
        style={{ left: checked ? 16 : 2 }}
      />
    </button>
  );
}
