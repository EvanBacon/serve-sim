import { useEffect, useState } from "react";

// Tracks the OS-level "increase contrast" preference. Consumers boost stroke
// widths and opacity so the curved arc handle stays legible at high contrast.
export function usePrefersMoreContrast(): boolean {
  const [more, setMore] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-contrast: more)").matches === true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-contrast: more)");
    const apply = () => setMore(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return more;
}
