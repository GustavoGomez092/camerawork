import { describe, expect, test } from "bun:test";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS } from "../src/looks.js";
import { cameraAt } from "../src/plan/interp.js";
import { buildKeyframes, MIN_MOVE, moveDuration } from "../src/plan/path.js";
import { DEFAULT_PLANNER as P, type Shot } from "../src/schema.js";

const layout = sceneLayout({ width: 1920, height: 1080 }, LOOKS.flat, 16 / 9);
const wide = { cx: 960, cy: 540, zoom: 1 };
const shot = (start: number, end: number, cx: number, cy: number, zoom: number): Shot => ({
  start,
  end,
  rect: [cx - 10, cy - 10, 20, 20],
  view: { cx, cy, zoom },
  source: "auto",
});
const times = (k: { t: number }[]) => k.map((f) => f.t);
const ordered = (k: { t: number }[]) => times(k).every((t, i, a) => i === 0 || t >= (a[i - 1] as number));

describe("moveDuration", () => {
  test("respects the pan-speed and zoom-rate caps, never below MIN_MOVE", () => {
    expect(moveDuration(wide, wide, layout, P)).toBe(MIN_MOVE);
    // 1152 px = 0.6 scene widths → 1 s at 0.6 widths/s
    expect(moveDuration(wide, { cx: 960 + 1152, cy: 540, zoom: 1 }, layout, P)).toBeCloseTo(1, 6);
    // zoom 1 → 2.25 = 1.5² → 2 s at 1.5×/s
    expect(moveDuration(wide, { cx: 960, cy: 540, zoom: 2.25 }, layout, P)).toBeCloseTo(2, 6);
  });
});

describe("buildKeyframes", () => {
  test("no shots: one wide hold over the whole video (Review Focus 3)", () => {
    expect(buildKeyframes([], layout, P, 6, false)).toEqual([
      { t: 0, ...wide },
      { t: 6, ...wide },
    ]);
  });

  test("the camera arrives `anticipation` seconds before the shot and holds at least minHold", () => {
    const k = buildKeyframes([shot(3, 3.2, 500, 400, 2)], layout, P, 10, false);
    expect(ordered(k)).toBe(true);
    expect(k.find((f) => f.zoom === 2)?.t).toBeCloseTo(3 - P.anticipation, 6);
    expect(cameraAt(k, 3 - P.anticipation + P.minHold - 0.01)).toEqual({ cx: 500, cy: 400, zoom: 2 });
  });

  test("a shot at t=0.1 starts already framed, never at negative time (Review Focus 4)", () => {
    const k = buildKeyframes([shot(0.1, 1, 500, 400, 2)], layout, P, 5, false);
    expect(k[0]).toEqual({ t: 0, cx: 500, cy: 400, zoom: 2 });
    expect(Math.min(...times(k))).toBe(0);
  });

  test("a shot near the end never pushes a keyframe past the duration (Review Focus 4)", () => {
    const k = buildKeyframes([shot(5.8, 5.9, 500, 400, 2)], layout, P, 6, true);
    expect(Math.max(...times(k))).toBe(6);
    expect(k[k.length - 1]).toMatchObject(wide);
  });

  test("similar zooms pan directly; very different zooms with a long gap go via wide", () => {
    const pan = buildKeyframes([shot(1, 2, 500, 400, 2), shot(3, 4, 1200, 600, 2.1)], layout, P, 8, false);
    // Between the two shots (before the idle drift back to wide after shot 2) the camera never goes wide.
    expect(pan.filter((f) => f.zoom === 1 && f.t > 0 && f.t < 4)).toHaveLength(0);
    const out = buildKeyframes([shot(1, 2, 500, 400, 2.2), shot(7, 8, 1300, 700, 1.3)], layout, P, 12, false);
    expect(out.some((f) => f.zoom === 1 && f.t > 2 && f.t < 7)).toBe(true);
  });

  test("loop mode starts and ends wide", () => {
    const k = buildKeyframes([shot(2, 3, 500, 400, 2)], layout, P, 8, true);
    expect(k[0]).toEqual({ t: 0, ...wide });
    expect(k[k.length - 1]).toEqual({ t: 8, ...wide });
  });

  test("no move is faster than its caps allow", () => {
    const shots = [shot(1.5, 2, 300, 300, 2.2), shot(2.6, 3, 1600, 800, 2.2), shot(5, 6, 900, 500, 1.4)];
    const k = buildKeyframes(shots, layout, P, 9, true);
    for (let i = 1; i < k.length; i++) {
      const a = k[i - 1] as (typeof k)[number];
      const b = k[i] as (typeof k)[number];
      if (a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom) continue;
      expect(b.t - a.t).toBeGreaterThanOrEqual(moveDuration(a, b, layout, P) - 1e-6);
    }
  });
});
