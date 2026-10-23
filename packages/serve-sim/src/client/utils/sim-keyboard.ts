/** HID usage for the R key (Usage Page 0x07). */
export const HID_KEY_R = 0x15;

const isModifierUsage = (usage: number) => usage >= 0xe0 && usage <= 0xe7;

export interface SimKeyEvent {
  type: "down" | "up";
  usage: number;
}

/**
 * Tracks which keys the simulator currently believes are held so a reload
 * tap is never sent on top of a key still down in the guest.
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
      // Already released on the sim side (by focus loss or a reload).
      if (!held.has(usage)) return [];
      held.delete(usage);
      return [{ type, usage }];
    },

    releaseAll,

    /**
     * React Native (RCTKeyCommands, Expo Go, expo-dev-client) reloads on a
     * bare `r` when no text field is first responder. Lift every held key
     * first: a held Cmd would turn the tap into Cmd+R, and a held R (left by
     * Cmd+R, whose R keyup macOS browsers never fire) swallows the tap.
     * Call restoreEvents() after the tap.
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
