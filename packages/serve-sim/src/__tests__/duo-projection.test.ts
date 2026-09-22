import { expect, test } from "bun:test";
import { pointOnDuoScreen, projectDuoRect } from "../client/utils/duo-projection";
import type { DuoProjection } from "../duo-renderer";

const projection: DuoProjection = { width: 1000, height: 900, panel: "inner", hingeDegrees: 130,
  pieces: [[[.2,.1],[.8,.2],[.7,.8],[.3,.9],[0,.5,1,.5]]] };
test("projects all four raw corners of a bent leaf without rotating touch twice", () => {
  expect(pointOnDuoScreen(projection,.2,.1)).toEqual({x:0,y:.5});
  const corner=pointOnDuoScreen(projection,.7,.8)!;
  expect(corner.x).toBeCloseTo(1); expect(corner.y).toBeCloseTo(1);
  expect(pointOnDuoScreen(projection,0,0)).toBeNull();
  expect(pointOnDuoScreen(null,.5,.5)).toBeNull();
});
test("perspective mapping agrees with a known projective transform", () => {
  // x=(.6u+.2)/(.5v+1), y=(.6v+.1)/(.5v+1)
  const project=(u:number,v:number)=>[(.6*u+.2)/(.5*v+1),(.6*v+.1)/(.5*v+1)];
  const shape={...projection,pieces:[[project(0,0),project(1,0),project(1,1),project(0,1),[0,0,1,1]]]};
  const [x,y]=project(.3,.7);
  const result=pointOnDuoScreen(shape,x!,y!)!;
  expect(result.x).toBeCloseTo(.3); expect(result.y).toBeCloseTo(.7);
});

test("AX rectangles project through the same transform as touch and split at the hinge", () => {
  const projection = { width: 1000, height: 900, panel: "inner", hingeDegrees: 130, pieces: [
    [[0.1, 0.1], [0.5, 0.2], [0.5, 0.8], [0.1, 0.9], [0, 0, 0.5, 1]],
    [[0.5, 0.2], [0.9, 0.1], [0.9, 0.9], [0.5, 0.8], [0.5, 0, 0.5, 1]],
  ] } as DuoProjection;
  const polygons = projectDuoRect(projection, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  expect(polygons).toHaveLength(2);
  for (const [i, polygon] of polygons.entries()) {
    const expected = i === 0 ? [[0.25, 0.25], [0.5, 0.25], [0.5, 0.75], [0.25, 0.75]] : [[0.5, 0.25], [0.75, 0.25], [0.75, 0.75], [0.5, 0.75]];
    polygon.forEach(([x, y], corner) => {
      const point = pointOnDuoScreen(projection, x!, y!)!;
      expect(point.x).toBeCloseTo(expected[corner]![0]!, 6);
      expect(point.y).toBeCloseTo(expected[corner]![1]!, 6);
    });
  }
});
