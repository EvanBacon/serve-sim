/** USB HID keyboard modifier usages, shared by guest input and browser input. */
export function isModifierUsage(usage: number): boolean {
  return Number.isInteger(usage) && usage >= 0xe0 && usage <= 0xe7;
}
