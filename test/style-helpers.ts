import { describe, expect, test } from "bun:test";
import { hexToLinear, linearToOklab } from "../src/backdrops/color.js";
import { renderField } from "../src/backdrops/field.js";
import type { StyleDef, StyleParams } from "../src/backdrops/types.js";

/** StyleParams for a w×h field from hex colours and the spec's defaults (angle 45, scale 1, distortion 0.3, seed 1). */
export function testParams(colors: string[], w = 160, h = 90, over: Partial<StyleParams> = {}): StyleParams {
  const short = Math.min(w, h);
  const rad = (45 * Math.PI) / 180;
  return {
    lab: colors.map((c) => linearToOklab(hexToLinear(c))),
    sin: Math.sin(rad),
    cos: Math.cos(rad),
    scale: 1,
    distortion: 0.3,
    seed: 1,
    speed: 0,
    uMax: w / short,
    vMax: h / short,
    ...over,
  };
}

/** Mean absolute difference per colour channel between two RGBA buffers. */
export function mad(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) sum += Math.abs((a[i] as number) - (b[i] as number));
  return sum / ((a.length * 3) / 4);
}

/** Standard deviation of the red, green and blue bytes together. */
export function spread(px: Uint8ClampedArray): number {
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let i = 0; i < px.length; i++) {
    if (i % 4 === 3) continue;
    const v = px[i] as number;
    sum += v;
    sq += v * v;
    n++;
  }
  return Math.sqrt(sq / n - (sum / n) ** 2);
}

/** The checks every style must pass (spec §8 "Styles" and "Motion"). */
export function describeStyle(name: string, style: StyleDef): void {
  const W = 160;
  const H = 90;
  const field = (p: StyleParams, t: number) => renderField(style.shade, p, W, H, t);

  describe(`style ${name}`, () => {
    test("has a description and a 2–5 colour default palette", () => {
      expect(style.description.length).toBeGreaterThan(10);
      expect(style.colors.length).toBeGreaterThanOrEqual(2);
      expect(style.colors.length).toBeLessThanOrEqual(5);
      for (const c of style.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    });

    test("is deterministic: the same settings give the same bytes", () => {
      const p = testParams(style.colors, W, H, { speed: 0.5 });
      expect(Buffer.from(field(p, 0.3)).equals(Buffer.from(field(p, 0.3)))).toBe(true);
    });

    test("returns finite colours near 0–1 everywhere", () => {
      const p = testParams(style.colors, W, H, { speed: 1, distortion: 1 });
      for (let i = 0; i < 400; i++) {
        const c = style.shade((i % 20) / 10, Math.floor(i / 20) / 20, (i % 7) / 7, p);
        for (const x of c) {
          expect(Number.isFinite(x)).toBe(true);
          expect(x).toBeGreaterThan(-0.15);
          expect(x).toBeLessThan(1.3);
        }
      }
    });

    test("is not a flat image", () => {
      expect(spread(field(testParams(style.colors, W, H), 0))).toBeGreaterThan(8);
    });

    test("works with 2 and with 5 colours (Review Focus 2)", () => {
      for (const colors of [
        ["#000000", "#ffffff"],
        ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff"],
      ])
        expect(spread(field(testParams(colors, W, H), 0))).toBeGreaterThan(8);
    });

    test("seed changes the picture or leaves it valid", () => {
      const a = field(testParams(style.colors, W, H, { seed: 1, distortion: 0.8 }), 0);
      const b = field(testParams(style.colors, W, H, { seed: 99, distortion: 0.8 }), 0);
      expect(mad(a, b)).toBeGreaterThan(0.5);
    });

    test("without motion, every t gives the same picture", () => {
      const p = testParams(style.colors, W, H);
      expect(mad(field(p, 0), field(p, 0.37))).toBe(0);
    });

    test("with motion it moves and loops seamlessly: t = 1 is t = 0, and the wrap is an ordinary step", () => {
      const p = testParams(style.colors, W, H, { speed: 1 });
      const n = 24;
      const frames = Array.from({ length: n }, (_, k) => field(p, k / n));
      const first = frames[0] as Uint8ClampedArray;
      expect(mad(first, field(p, 1))).toBeLessThan(0.01);
      const steps = frames.map((f, k) => mad(f, frames[(k + 1) % n] as Uint8ClampedArray));
      const wrap = steps[n - 1] as number;
      expect(wrap).toBeLessThanOrEqual(Math.max(...steps.slice(0, n - 1)) * 1.1 + 0.05);
      expect(Math.max(...frames.map((f) => mad(first, f)))).toBeGreaterThan(1);
    });
  });
}
