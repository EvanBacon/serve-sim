import { SimulatorToolbar } from "../simulator";
import type { ReactElement } from "react";

type AndroidButton =
  | "back"
  | "home"
  | "recents"
  | "volume_down"
  | "volume_up"
  | "power";

const CONTROLS: Array<{
  button: AndroidButton;
  label: string;
  title: string;
  icon: ReactElement;
}> = [
  {
    button: "back",
    label: "Android Back",
    title: "Back",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M15 6 8 12l7 6V6Z" fill="currentColor" />
      </svg>
    ),
  },
  {
    button: "home",
    label: "Android Home",
    title: "Home",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="5.5" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
  },
  {
    button: "recents",
    label: "Android Recents",
    title: "Recents",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
  },
  {
    button: "volume_down",
    label: "Android Volume Down",
    title: "Volume Down",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 10v4h4l5 4V6l-5 4H4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M17 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    button: "volume_up",
    label: "Android Volume Up",
    title: "Volume Up",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 10v4h4l5 4V6l-5 4H4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M18.5 9.5v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M16 12h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    button: "power",
    label: "Android Power",
    title: "Power",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M7.5 6.7a7 7 0 1 0 9 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function AndroidDeviceControls({
  onButton,
}: {
  onButton: (button: AndroidButton) => void;
}) {
  return (
    <>
      {CONTROLS.map((control) => (
        <SimulatorToolbar.Button
          key={control.button}
          aria-label={control.label}
          title={control.title}
          onClick={() => onButton(control.button)}
        >
          {control.icon}
        </SimulatorToolbar.Button>
      ))}
    </>
  );
}
