import { expect, test } from "bun:test";
import { beginDuoTouch, moveDuoTouch } from "../client/utils/duo-home-gesture";

test("home swipes retain the guest edge on both panels in every orientation", () => {
  for (const [width, height] of [[1398, 2034], [2007, 2853]]) {
    for (const [orientation, x, y, edge] of [
      ["portrait", 0.5, 0.99, 3], ["landscape_left", 0.99, 0.5, 4],
      ["landscape_right", 0.01, 0.5, 1], ["portrait_upside_down", 0.5, 0.01, 2],
    ] as const) {
      const start = beginDuoTouch({ x, y }, { width: width!, height: height!, orientation });
      expect(start.edge).toBe(edge);
      const move = moveDuoTouch(start, { x: 0.5, y: 0.5 });
      expect(move.edge).toBe(edge);
      expect(moveDuoTouch(move, { x: 0.4, y: 0.4 }).edge).toBe(edge);
      expect(beginDuoTouch({ x: 0.5, y: 0.5 }, { width: width!, height: height!, orientation }).edge).toBeUndefined();
    }
  }
});
