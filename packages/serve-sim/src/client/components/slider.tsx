import type { ComponentProps, CSSProperties } from "react";

type SliderProps = Omit<ComponentProps<"input">, "type" | "min" | "max" | "value"> & {
  min: number;
  max: number;
  value: number;
};

export function Slider({ min, max, value, disabled, className = "", style, ...props }: SliderProps) {
  const fraction = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const fill = `${fraction * 100}%`;
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


  return <input
    {...props}
    type="range"
    min={min}
    max={max}
    value={value}
    disabled={disabled}
    style={{ "--slider-fill": fill, "--slider-fill-color": fillColor, ...style } as CSSProperties}
    className={`h-[13px] w-full appearance-none rounded-full bg-transparent outline-none focus-visible:[outline:1.5px_solid_rgba(10,132,255,0.55)] focus-visible:outline-offset-4 ${disabled ? "cursor-default" : "cursor-pointer"} ${trackClasses} ${thumbClasses} ${className}`}
  />;
}
