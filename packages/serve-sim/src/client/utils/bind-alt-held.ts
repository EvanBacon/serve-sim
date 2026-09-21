/** Follow the modifier across keyboard and pointer input, including focus loss. */
export function bindAltHeld(target: EventTarget, onChange: (held: boolean) => void): () => void {
  const update = (event: Event) => onChange((event as KeyboardEvent | PointerEvent).altKey === true);
  const reset = () => onChange(false);
  const events = ["keydown", "keyup", "pointermove", "pointerdown"];
  for (const event of events) target.addEventListener(event, update);
  target.addEventListener("blur", reset);
  return () => {
    for (const event of events) target.removeEventListener(event, update);
    target.removeEventListener("blur", reset);
  };
}
