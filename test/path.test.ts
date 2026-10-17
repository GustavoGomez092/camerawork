import { describe, expect, test } from "bun:test";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS } from "../src/looks.js";
import type { PlanEvent } from "../src/plan/cues.js";
import { cameraAt } from "../src/plan/interp.js";
import { buildKeyframes, MIN_MOVE, moveDuration } from "../src/plan/path.js";
import { clusterShots } from "../src/plan/shots.js";
import { DEFAULT_PLANNER as P, type Shot, type View } from "../src/schema.js";

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

const consistent = (k: { t: number; cx: number; cy: number; zoom: number }[]) => {
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1] as (typeof k)[number];
    const b = k[i] as (typeof k)[number];
    expect(b.t).toBeGreaterThanOrEqual(a.t);
    if (b.t === a.t) expect(b).toEqual(a);
  }
};
const capsHold = (k: ReturnType<typeof buildKeyframes>, slack = 1e-6) => {
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1] as (typeof k)[number];
    const b = k[i] as (typeof k)[number];
    if (a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom) continue;
    expect(b.t - a.t).toBeGreaterThanOrEqual(moveDuration(a, b, layout, P) - slack);
  }
};
const A = [500, 400, 2] as const;

describe("fix round 1", () => {
  test("minHold holds after a same-view drift-and-return", () => {
    const k = buildKeyframes(
      [shot(1, 2, ...A), shot(10, 10.2, ...A), shot(10.5, 11, 1500, 700, 2)],
      layout,
      P,
      16,
      false,
    );
    consistent(k);
    const back = 10 - P.anticipation;
    expect(cameraAt(k, back + P.minHold - 0.01)).toEqual({ cx: 500, cy: 400, zoom: 2 });
  });

  test("a loop never hard-cuts to wide at the duration", () => {
    const k = buildKeyframes([shot(1, 5.8, ...A), shot(5.9, 6, 1500, 700, 2)], layout, P, 6, true);
    consistent(k);
    expect(k[k.length - 1]).toEqual({ t: 6, ...wide });
  });

  test("time-ordered with equal times meaning equal views, across scenarios", () => {
    consistent(buildKeyframes([shot(5.8, 5.9, ...A)], layout, P, 6, false));
    consistent(buildKeyframes([shot(1, 5.8, ...A), shot(5.9, 6, 1500, 700, 2)], layout, P, 6, false));
    consistent(buildKeyframes([shot(1.5, 2, 300, 300, 2.2), shot(2.6, 3, 1600, 800, 2.2)], layout, P, 9, true));
  });

  test("a big zoom change with a short gap eases out partway (zoomOutGap)", () => {
    const k = buildKeyframes([shot(1, 2, 500, 400, 2.2), shot(4.35, 5, 1300, 700, 1.3)], layout, P, 9, false);
    consistent(k);
    capsHold(k);
    expect(k.some((f) => f.t > 1.5 && f.zoom > 1 && f.zoom < 1.3)).toBe(true);
  });

  test("idle drift waits idleWide after the last shot", () => {
    const k = buildKeyframes([shot(1, 2, ...A)], layout, P, 12, false);
    expect(cameraAt(k, 2 + P.idleWide - 0.1)).toEqual({ cx: 500, cy: 400, zoom: 2 });
    expect(cameraAt(k, 2 + P.idleWide + 0.3).zoom).toBeLessThan(2);
    capsHold(k);
  });
});

describe("stay while the next target is already in view (R-b)", () => {
  const A = shot(1, 2, 500, 400, 2); // view x 20..980, y 130..670
  const sameV = (a: { cx: number; cy: number; zoom: number }, b: { cx: number; cy: number; zoom: number }) =>
    Math.abs(a.cx - b.cx) < 0.5 && Math.abs(a.cy - b.cy) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-3;
  /** Every keyframe from the arrival at A until the loop's return to wide is A's view. */
  const heldOnA = (k: ReturnType<typeof buildKeyframes>) => {
    const first = k.findIndex((f) => sameV(f, A.view));
    expect(first).toBeGreaterThan(0);
    const rest = k.slice(first);
    let lastA = rest.length - 1;
    while (lastA > 0 && !sameV(rest[lastA] as (typeof rest)[number], A.view)) lastA--;
    for (const f of rest.slice(0, lastA + 1)) expect(f).toMatchObject(A.view);
    for (const f of rest.slice(lastA + 1)) expect(f).toMatchObject(wide);
  };

  test("a later shot whose target lies inside the zoomed view does not move the camera", () => {
    const B = shot(3, 4, 600, 450, 2.2);
    const C = shot(4.5, 4.6, 400, 300, 2.1);
    const k = buildKeyframes([A, B, C], layout, P, 9, true);
    heldOnA(k);
    // the hold extends to the last shot inside the view
    expect(cameraAt(k, 4.6 + P.minHold - 0.01)).toEqual(A.view);
  });

  test("a later shot outside the view still moves", () => {
    const B = shot(3, 4, 1500, 700, 2.2);
    const k = buildKeyframes([A, B], layout, P, 9, true);
    expect(k.some((f) => sameV(f, B.view))).toBe(true);
  });

  test("a target touching the view's edge (inside the 2 % inset) still moves", () => {
    const B: Shot = { ...shot(3, 4, 950, 400, 2.2), rect: [930, 390, 45, 20] }; // right edge 975 of 980
    const k = buildKeyframes([A, B], layout, P, 9, true);
    expect(k.some((f) => sameV(f, B.view))).toBe(true);
  });

  test("a wide camera still zooms into a small target", () => {
    const k = buildKeyframes([shot(2, 3, 600, 450, 2.2)], layout, P, 8, true);
    expect(k.some((f) => f.zoom === 2.2)).toBe(true);
  });

  test("a cue inside the view still re-frames", () => {
    const cue: Shot = { ...shot(3, 4, 600, 450, 2.2), source: "cue" };
    const k = buildKeyframes([A, cue], layout, P, 9, true);
    expect(k.some((f) => sameV(f, cue.view))).toBe(true);
  });

  test("a target touching the window edge that the view already sits on stays (no inset on that side)", () => {
    const corner = shot(1, 2, 480, 270, 2); // view x 0..960, y 0..540: at the window's left and top edges
    const B: Shot = { ...shot(3, 4, 436, 245, 2.2), rect: [2, 100, 40, 20] }; // 2 px from the left edge
    const k = buildKeyframes([corner, B], layout, P, 9, true);
    expect(k.some((f) => sameV(f, B.view))).toBe(false);
    expect(cameraAt(k, 4 + P.minHold - 0.01)).toEqual(corner.view);
  });
});

describe("stay if visible, real-geometry repros (R-b review)", () => {
  const hero = sceneLayout({ width: 3840, height: 2160 }, LOOKS.hero, 16 / 9);
  const p = { ...P, maxZoom: 1.83 };
  const ev = (t: number, rect: [number, number, number, number], weight: number): PlanEvent => ({
    start: t,
    end: t + 1 / 15,
    rect,
    source: "auto",
    weight,
  });
  const near = (a: View, b: View) =>
    Math.abs(a.cx - b.cx) < 0.5 && Math.abs(a.cy - b.cy) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-3;

  test("after an idle drift to wide, the camera frames the new shot itself, not the old view", () => {
    const shots = clusterShots([ev(1, [2000, 300, 1200, 600], 200000), ev(10, [2100, 400, 40, 20], 400)], hero, p);
    expect(shots).toHaveLength(2);
    const first = shots[0] as Shot;
    const second = shots[1] as Shot;
    const k = buildKeyframes(shots, hero, p, 16, true);
    const wideAt = k.findIndex((f, i) => i > 0 && f.zoom === 1);
    expect(wideAt).toBeGreaterThan(0);
    const after = k.slice(wideAt);
    expect(after.some((f) => near(f, second.view))).toBe(true);
    expect(after.some((f) => near(f, first.view))).toBe(false);
  });

  test("a near-wide zoomed view does not freeze later zoom-ins on small changes inside it", () => {
    const shots = clusterShots(
      [ev(1, [100, 100, 3600, 1800], 900000), ev(4, [300, 300, 60, 30], 900), ev(7, [3000, 1500, 60, 30], 900)],
      hero,
      p,
    );
    expect(shots).toHaveLength(3);
    expect((shots[0] as Shot).view.zoom).toBeLessThan(1.1);
    const k = buildKeyframes(shots, hero, p, 14, true);
    for (const s of shots.slice(1)) expect(k.some((f) => near(f, s.view))).toBe(true);
  });
});
