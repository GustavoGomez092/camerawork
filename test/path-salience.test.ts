import { describe, expect, test } from "bun:test";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS } from "../src/looks.js";
import { cameraAt } from "../src/plan/interp.js";
import { buildKeyframes, moveDuration } from "../src/plan/path.js";
import { type Keyframe, DEFAULT_PLANNER as P, type Shot, type View } from "../src/schema.js";

const layout = sceneLayout({ width: 1920, height: 1080 }, LOOKS.flat, 16 / 9);
const wide: View = { cx: 960, cy: 540, zoom: 1 };
type WShot = Shot & { weight?: number };
const shot = (start: number, end: number, view: View, weight: number, source: "auto" | "cue" = "auto"): WShot => ({
  start,
  end,
  rect: [view.cx - 10, view.cy - 10, 20, 20],
  view,
  source,
  weight,
});
const sameView = (a: View, b: View) =>
  Math.abs(a.cx - b.cx) < 0.5 && Math.abs(a.cy - b.cy) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-3;
/** First time the camera sits exactly on `v`, or undefined. */
const arrival = (k: Keyframe[], v: View) => k.find((f) => sameView(f, v))?.t;
const deadline = (s: Shot) => s.end + P.minHold;

/**
 * The calm invariant: keyframes in time order, equal times mean equal views, first at 0 and last at the duration,
 * and every move (the last one included) takes at least moveDuration. Compression is allowed only when the video is
 * too short for even one capped move, and then there is exactly one move.
 */
function expectCalm(k: Keyframe[], duration: number, loop: boolean) {
  expect(k[0]?.t).toBe(0);
  expect(k[k.length - 1]?.t).toBeCloseTo(duration, 9);
  if (loop) {
    expect(sameView(k[0] as Keyframe, wide)).toBe(true);
    expect(sameView(k[k.length - 1] as Keyframe, wide)).toBe(true);
  }
  let moves = 0;
  let compressed = false;
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1] as Keyframe;
    const b = k[i] as Keyframe;
    expect(b.t).toBeGreaterThanOrEqual(a.t);
    if (sameView(a, b)) continue;
    expect(b.t - a.t).toBeGreaterThan(0); // no same-time different-view pair (a hard cut)
    moves++;
    const need = moveDuration(a, b, layout, P);
    if (b.t - a.t < need - 1e-6) {
      compressed = true;
      expect(duration).toBeLessThan(need);
    }
  }
  if (compressed) expect(moves).toBe(1);
}

describe("stale and competing shots (F3)", () => {
  // The reviewer's repro: one UI update touches three far-apart corners at 0.4 s; the real change is a big panel at 2.3 s.
  const corners = [
    shot(0.4, 0.4 + 1 / 15, { cx: 436, cy: 245, zoom: 2.2 }, 3600),
    shot(0.4, 0.4 + 1 / 15, { cx: 1484, cy: 245, zoom: 2.2 }, 3600),
    shot(0.4, 0.4 + 1 / 15, { cx: 436, cy: 835, zoom: 2.2 }, 3600),
  ];
  const panel = shot(2.3, 2.3 + 1 / 15, { cx: 1400, cy: 800, zoom: 1.75 }, 160000);

  for (const loop of [true, false]) {
    test(`the big later panel is framed within its own window (${loop ? "loop" : "no loop"})`, () => {
      const k = buildKeyframes([...corners, panel], layout, P, 7, loop);
      expectCalm(k, 7, loop);
      const t = arrival(k, panel.view);
      expect(t).toBeDefined();
      expect(t as number).toBeLessThanOrEqual(deadline(panel));
      // never goes back to a corner once the panel happened
      for (const c of corners) expect(k.some((f) => f.t > 2.3 && sameView(f, c.view))).toBe(false);
    });
  }

  test("a shot the camera can only reach after its end + minHold is skipped", () => {
    const k = buildKeyframes([corners[0] as WShot, panel], layout, P, 7, true);
    expect(arrival(k, (corners[0] as WShot).view)).toBeUndefined();
  });

  test("a smaller change during a longer shot elsewhere does not pull the camera away", () => {
    const typing = shot(1, 5, { cx: 600, cy: 400, zoom: 2 }, 8000);
    const blip = shot(3, 3 + 1 / 15, { cx: 1500, cy: 900, zoom: 2.2 }, 500);
    const k = buildKeyframes([typing, blip], layout, P, 10, false);
    expectCalm(k, 10, false);
    expect(arrival(k, blip.view)).toBeUndefined();
    expect(cameraAt(k, 4.9)).toEqual(typing.view);
  });

  test("a bigger change during a longer shot elsewhere is framed in its window", () => {
    const typing = shot(1, 5, { cx: 600, cy: 400, zoom: 2 }, 8000);
    const big = shot(3, 3 + 1 / 15, { cx: 1400, cy: 760, zoom: 1.6 }, 90000);
    const k = buildKeyframes([typing, big], layout, P, 10, false);
    expectCalm(k, 10, false);
    expect(arrival(k, big.view) as number).toBeLessThanOrEqual(deadline(big));
  });

  test("a palette opening, then a bigger tile appearing as it closes: both are framed (real master shape)", () => {
    const palette = shot(0.87, 1.53, { cx: 960, cy: 330, zoom: 1.83 }, 660000);
    const tile = shot(2.27, 2.33, { cx: 1450, cy: 790, zoom: 1.83 }, 1530000);
    const k = buildKeyframes([palette, tile], layout, P, 6.97, true);
    expectCalm(k, 6.97, true);
    expect(arrival(k, palette.view) as number).toBeLessThanOrEqual(deadline(palette));
    expect(arrival(k, tile.view) as number).toBeLessThanOrEqual(deadline(tile));
  });

  test("cue shots are never skipped, even when late", () => {
    const cue = shot(0.4, 0.5, { cx: 436, cy: 245, zoom: 2.2 }, 0, "cue");
    const k = buildKeyframes([cue, panel], layout, P, 7, true);
    expect(arrival(k, cue.view)).toBeDefined();
  });
});

describe("loop end and move caps (C1c)", () => {
  test("a loop with a shot near the end cuts the hold, not the final move", () => {
    const s = shot(4.2, 4.3, { cx: 600, cy: 400, zoom: 2 }, 5000);
    const k = buildKeyframes([s], layout, P, 6, true);
    expectCalm(k, 6, true);
    expect(arrival(k, s.view)).toBeDefined();
  });

  test("a loop whose last shot cannot both be reached and left in time skips it rather than rushing", () => {
    const s = shot(5.6, 5.7, { cx: 600, cy: 400, zoom: 2 }, 5000);
    const k = buildKeyframes([shot(1, 2, { cx: 1300, cy: 700, zoom: 1.5 }, 4000), s], layout, P, 6, true);
    expectCalm(k, 6, true);
  });

  test("a loop still drifts back to wide idleWide after the last shot when the video goes on", () => {
    const s = shot(1, 2, { cx: 600, cy: 400, zoom: 2 }, 5000);
    const k = buildKeyframes([s], layout, P, 12, true);
    expectCalm(k, 12, true);
    const back = moveDuration(s.view, wide, layout, P);
    expect(cameraAt(k, 2 + P.idleWide - 0.05)).toEqual(s.view);
    expect(cameraAt(k, 2 + P.idleWide + back + 0.01)).toEqual(wide);
  });

  test("a video too short for one capped move makes exactly one compressed move", () => {
    const s = shot(0.1, 0.2, { cx: 600, cy: 400, zoom: 2.2 }, 5000, "cue");
    expectCalm(buildKeyframes([s], layout, P, 1, true), 1, true);
  });

  test("every move respects its caps across many generated scenarios", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 300; n++) {
      const duration = 2 + rnd() * 14;
      const loop = rnd() < 0.5;
      const count = Math.floor(rnd() * 7);
      const shots: WShot[] = [];
      for (let i = 0; i < count; i++) {
        const zoom = 1 + rnd() * 1.2;
        const vw = 1920 / zoom;
        const vh = 1080 / zoom;
        const start = rnd() * duration;
        shots.push(
          shot(
            start,
            Math.min(duration, start + (rnd() < 0.5 ? 1 / 15 : rnd() * 3)),
            { cx: vw / 2 + rnd() * (1920 - vw), cy: vh / 2 + rnd() * (1080 - vh), zoom },
            1 + rnd() * 100000,
          ),
        );
      }
      shots.sort((a, b) => a.start - b.start);
      expectCalm(buildKeyframes(shots, layout, P, duration, loop), duration, loop);
    }
  });
});
