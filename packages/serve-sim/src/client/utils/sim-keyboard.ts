const META_USAGES = new Set([0xe3, 0xe7]);
const isModifierUsage = (usage: number) => usage >= 0xe0 && usage <= 0xe7;

export interface SimKeyEvent {
  type: "down" | "up";
  usage: number;
}

/**
 * Tracks which keys the simulator currently believes are held so forwarded
 * key events never leave a key stuck down in the guest.
 */
export function createSimKeyState() {
  const held = new Set<number>();

  return {
    held: held as ReadonlySet<number>,

    /** Events to send to the sim for a browser keydown/keyup. */
    forward(type: "down" | "up", usage: number): SimKeyEvent[] {
      if (type === "down") {
        held.add(usage);
        return [{ type, usage }];
      }
      // Already released on the sim side (by Cmd release or focus loss).
      if (!held.has(usage)) return [];
      held.delete(usage);
      const events: SimKeyEvent[] = [];
      if (META_USAGES.has(usage)) {
        // macOS browsers don't fire keyup for keys pressed while Cmd is down,
        // so release them along with Cmd; a key left held in the guest
        // swallows its next press (e.g. the toolbar Reload's R tap after Cmd+R).
        for (const other of [...held]) {
          if (isModifierUsage(other)) continue;
          held.delete(other);
          events.push({ type: "up", usage: other });
        }
      }
      events.push({ type, usage });
      return events;
    },

    /** Lift every held key, e.g. when the sim loses keyboard focus. */
    releaseAll(): SimKeyEvent[] {
      const events = [...held].map((usage): SimKeyEvent => ({ type: "up", usage }));
      held.clear();
      return events;
    },
  };
}
