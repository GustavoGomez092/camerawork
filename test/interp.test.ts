import { describe, expect, test } from "bun:test";
import { cameraAt, easeInOutCubic } from "../src/plan/interp.js";

const kfs = [
  { t: 0, cx: 960, cy: 540, zoom: 1 },
  { t: 1, cx: 960, cy: 540, zoom: 1 },
  { t: 2, cx: 500, cy: 300, zoom: 2 },
];

describe("interpolation", () => {
  test("easing is 0 → 0.5 → 1 and symmetric", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 10);
  });

  test("holds before, between equal keyframes and after", () => {
    expect(cameraAt(kfs, -1)).toEqual({ cx: 960, cy: 540, zoom: 1 });
    expect(cameraAt(kfs, 0.5)).toEqual({ cx: 960, cy: 540, zoom: 1 });
    expect(cameraAt(kfs, 9)).toEqual({ cx: 500, cy: 300, zoom: 2 });
  });

  test("halfway through a move: center halfway, zoom the geometric mean", () => {
    const v = cameraAt(kfs, 1.5);
    expect(v.cx).toBeCloseTo(730, 6);
    expect(v.cy).toBeCloseTo(420, 6);
    expect(v.zoom).toBeCloseTo(Math.SQRT2, 6);
  });
});
