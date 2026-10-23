/** HID usage for the R key (Usage Page 0x07). */
export const HID_KEY_R = 0x15;

const META_USAGES = new Set([0xe3, 0xe7]);
const isModifierUsage = (usage: number) => usage >= 0xe0 && usage <= 0xe7;

export interface SimKeyEvent {
  type: "down" | "up";
  usage: number;
}

type ModifierState = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/**
 * Cmd+R. Browsers let pages cancel it, so the preview can turn it into a
 * React Native reload instead of reloading itself. Cmd+Shift+R is not
 * matched: like any other chord it is forwarded to the sim as keys.
 */
export function isReloadShortcut(e: ModifierState): boolean {
  return e.code === "KeyR" && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** Keys that activate or move between focused toolbar buttons. */
const BUTTON_KEY_CODES = new Set(["Tab", "Enter", "NumpadEnter", "Space"]);

/**
 * Whether a key should keep its native browser behavior instead of going to
 * the sim because a toolbar control under the device has DOM focus (Enter
 * and Space press the button, Tab moves between buttons).
 */
export function keepsNativeButtonKey(code: string): boolean {
  return BUTTON_KEY_CODES.has(code);
}

/**
 * Form controls in the toolbar (e.g. the Duo hinge slider) need real DOM
 * focus for their own keyboard handling, so clicking them hands the keyboard
 * to the browser rather than keeping it on the sim.
 */
export function isFormControlTarget(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === "function" && el.closest("input, select, textarea") != null;
}

/**
 * Tracks which keys the simulator currently believes are held so forwarded
 * key events never leave a key stuck down in the guest.
 */
export function createSimKeyState() {
  const held = new Set<number>();
  // Modifiers lifted for a reload tap that the user is still holding; pressed
  // again by restoreEvents() unless released (or re-pressed) meanwhile.
  const toRestore = new Set<number>();

  const releaseAll = (): SimKeyEvent[] => {
    const events = [...held].map((usage): SimKeyEvent => ({ type: "up", usage }));
    held.clear();
    toRestore.clear();
    return events;
  };

  return {
    held: held as ReadonlySet<number>,

    /** Events to send to the sim for a browser keydown/keyup. */
    forward(type: "down" | "up", usage: number): SimKeyEvent[] {
      toRestore.delete(usage);
      if (type === "down") {
        held.add(usage);
        return [{ type, usage }];
      }
      // Already released on the sim side (by Cmd release, focus loss or a reload).
      if (!held.has(usage)) return [];
      held.delete(usage);
      const events: SimKeyEvent[] = [];
      if (META_USAGES.has(usage)) {
        // macOS browsers don't fire keyup for keys pressed while Cmd is down,
        // so release them along with Cmd; a key left held in the guest
        // swallows its next press.
        for (const other of [...held]) {
          if (isModifierUsage(other)) continue;
          held.delete(other);
          events.push({ type: "up", usage: other });
        }
      }
      events.push({ type, usage });
      return events;
    },

    releaseAll,

    /**
     * React Native (RCTKeyCommands, Expo Go, expo-dev-client) reloads on a
     * bare `r` when no text field is first responder, but the guest never
     * reloads for Cmd+R injected through Indigo. Lift every held key (a held
     * Cmd would turn the tap back into Cmd+R, a held R would swallow it) and
     * tap R. Call restoreEvents() after the tap.
     */
    reloadEvents(): { release: SimKeyEvent[]; tap: number } {
      const release = releaseAll();
      for (const ev of release) if (isModifierUsage(ev.usage)) toRestore.add(ev.usage);
      return { release, tap: HID_KEY_R };
    },

    /**
     * Press the modifiers lifted by reloadEvents() again, so the sim matches
     * what the user holds and their later keyup is forwarded. A modifier
     * released during the tap is not pressed again, or it would stay stuck.
     */
    restoreEvents(): SimKeyEvent[] {
      const events = [...toRestore]
        .filter((usage) => !held.has(usage))
        .map((usage): SimKeyEvent => ({ type: "down", usage }));
      for (const ev of events) held.add(ev.usage);
      toRestore.clear();
      return events;
    },
  };
}
