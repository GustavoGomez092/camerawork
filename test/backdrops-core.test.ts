import { describe, expect, test } from "bun:test";
import { hexToLinear, linearToOklab, mixLab, oklabToLinear, paletteAt, toByte } from "../src/backdrops/color.js";
import { FIELD_MAX, fieldSize, renderField } from "../src/backdrops/field.js";
import { gradientLine } from "../src/backdrops/gradient.js";
import { fbm, hash3, noise2, rand, smoothstep, tri } from "../src/backdrops/noise.js";
import { applyGrain, applyVignette, grainCell } from "../src/backdrops/post.js";
import { across, along } from "../src/backdrops/space.js";
import type { ShadeFn, Vec3 } from "../src/backdrops/types.js";
import { testParams } from "./style-helpers.js";

const flat = (w: number, h: number, v: number) =>
  new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : v));

describe("colour", () => {
  test("OKLab round-trips and has white at L = 1", () => {
    for (const hex of ["#000000", "#ffffff", "#ff2bd6", "#1a0b3d", "#7b2bff"]) {
      const lin = hexToLinear(hex);
      const back = oklabToLinear(...linearToOklab(lin));
      for (let i = 0; i < 3; i++) expect(back[i] as number).toBeCloseTo(lin[i] as number, 5);
    }
    expect(linearToOklab([1, 1, 1])[0]).toBeCloseTo(1, 4);
  });

  test("palettes mix in OKLab: halfway between black and white is sRGB 99, not 128", () => {
    const lab = [linearToOklab(hexToLinear("#000000")), linearToOklab(hexToLinear("#ffffff"))];
    const mid = paletteAt(lab, 0.5);
    expect(toByte(mid[0])).toBe(99);
    expect(toByte(mixLab(lab[0] as Vec3, lab[1] as Vec3, 0.5)[1])).toBe(99);
  });

  test("palette ends are the first and last colours; x is clamped", () => {
    const lab = ["#ff0000", "#00ff00", "#0000ff"].map((c) => linearToOklab(hexToLinear(c)));
    expect(paletteAt(lab, -1).map(toByte)).toEqual([255, 0, 0]);
    expect(paletteAt(lab, 2).map(toByte)).toEqual([0, 0, 255]);
  });

  test("toByte clamps and treats NaN as 0", () => {
    expect([toByte(-1), toByte(0), toByte(1), toByte(2), toByte(Number.NaN)]).toEqual([0, 0, 255, 255, 0]);
  });
});

describe("noise", () => {
  test("hash3 is deterministic, in [0, 1), and depends on every input", () => {
    expect(hash3(1, 2, 3)).toBe(hash3(1, 2, 3));
    for (const h of [hash3(1, 2, 3), hash3(2, 2, 3), hash3(1, 3, 3), hash3(1, 2, 4)]) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
    expect(new Set([hash3(1, 2, 3), hash3(2, 2, 3), hash3(1, 3, 3), hash3(1, 2, 4)]).size).toBe(4);
    expect(rand(7, 0)).not.toBe(rand(7, 1));
  });

  test("value noise and fbm are smooth and stay in [0, 1]", () => {
    for (let i = 0; i < 500; i++) {
      const x = i * 0.137 - 30;
      const y = i * 0.071 + 5;
      const n = noise2(3, x, y);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
      expect(Math.abs(noise2(3, x + 0.001, y) - n)).toBeLessThan(0.01);
      const f = fbm(3, x, y, 3);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  test("smoothstep and tri", () => {
    expect([smoothstep(0, 1, -1), smoothstep(0, 1, 0.5), smoothstep(0, 1, 2)]).toEqual([0, 0.5, 1]);
    expect([tri(0), tri(0.25), tri(0.5), tri(1), tri(-0.5)]).toEqual([0, 0.5, 1, 0, 1]);
  });
});

describe("pattern space", () => {
  test("angle 90 runs left to right; angle 0 runs upwards", () => {
    const right = testParams(["#000000", "#ffffff"], 200, 100, { sin: 1, cos: 0 });
    expect(along(2, 0.5, right)).toBeCloseTo(1, 9);
    expect(along(0, 0.5, right)).toBeCloseTo(-1, 9);
    const up = testParams(["#000000", "#ffffff"], 200, 100, { sin: 0, cos: 1 });
    expect(along(1, 0, up)).toBeCloseTo(0.5, 9);
    expect(across(2, 0.5, up)).toBeCloseTo(1, 9);
  });
});

describe("field", () => {
  test("fieldSize keeps the aspect, caps the long side at 1280 and is even", () => {
    expect(FIELD_MAX).toBe(1280);
    expect(fieldSize(4688, 2636)).toEqual([1280, 720]);
    expect(fieldSize(640, 360)).toEqual([640, 360]);
    expect(fieldSize(9368, 5272)).toEqual([1280, 720]);
    expect(fieldSize(2636, 4688)).toEqual([720, 1280]);
    expect(fieldSize(1, 1)).toEqual([2, 2]);
  });

  test("renders opaque pixels with the short side spanning 0–1", () => {
    let maxU = 0;
    let maxV = 0;
    const shade: ShadeFn = (u, v) => {
      maxU = Math.max(maxU, u);
      maxV = Math.max(maxV, v);
      return [1, 0, 0];
    };
    const px = renderField(shade, testParams(["#000000", "#ffffff"], 200, 100), 200, 100, 0);
    expect(maxU).toBeCloseTo(2 - 0.005, 6);
    expect(maxV).toBeCloseTo(1 - 0.005, 6);
    expect([...px.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(px[px.length - 1]).toBe(255);
  });

  test("the same settings look the same at any resolution", () => {
    const shade: ShadeFn = (u, v, _t, p) => paletteAt(p.lab, (u / p.uMax + v) / 2);
    const small = renderField(shade, testParams(["#102030", "#f0e0d0"], 160, 90), 160, 90, 0);
    const big = renderField(shade, testParams(["#102030", "#f0e0d0"], 320, 180), 320, 180, 0);
    // pixel (40, 20) in the small field covers pixels (80–81, 40–41) in the big one
    const s = (40 + 20 * 160) * 4;
    const b = (81 + 41 * 320) * 4;
    expect(Math.abs((small[s] as number) - (big[b] as number))).toBeLessThanOrEqual(2);
  });
});

describe("post", () => {
  test("vignette leaves the centre and darkens the corners", () => {
    const px = flat(100, 50, 200);
    applyVignette(px, 100, 50, 1);
    expect(px[(25 * 100 + 50) * 4]).toBe(200);
    expect(px[0] as number).toBeLessThan(60);
    const none = flat(10, 10, 200);
    applyVignette(none, 10, 10, 0);
    expect(none.every((v, i) => v === (i % 4 === 3 ? 255 : 200))).toBe(true);
  });

  test("grain is monochrome, seeded per frame, bounded and roughly zero-mean", () => {
    const run = (frame: number) => {
      const px = flat(64, 64, 128);
      applyGrain(px, 64, 64, { grain: 0.1, seed: 5, frame, cell: 1 });
      return px;
    };
    const a = run(0);
    expect(Buffer.from(a).equals(Buffer.from(run(0)))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(run(1)))).toBe(false);
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) {
      expect(a[i]).toBe(a[i + 1] as number);
      expect(a[i]).toBe(a[i + 2] as number);
      expect(Math.abs((a[i] as number) - 128)).toBeLessThanOrEqual(13);
      sum += (a[i] as number) - 128;
    }
    expect(Math.abs(sum / (64 * 64))).toBeLessThan(1);
  });

  test("grain cells: cell 2 makes 2×2 blocks; grainCell sizes cells for a 1920-px scene", () => {
    const px = flat(8, 8, 128);
    applyGrain(px, 8, 8, { grain: 0.3, seed: 1, frame: 0, cell: 2 });
    expect(px[0]).toBe(px[4] as number);
    expect(px[0]).toBe(px[8 * 4] as number);
    expect([grainCell(1000), grainCell(1920), grainCell(3840), grainCell(4688)]).toEqual([1, 1, 2, 2]);
  });
});

describe("gradient line", () => {
  test("CSS angles: 180 is top to bottom, 90 is left to right", () => {
    expect(gradientLine(100, 100, 180).map((n) => Math.round(n))).toEqual([50, 0, 50, 100]);
    expect(gradientLine(200, 100, 90).map((n) => Math.round(n))).toEqual([0, 50, 200, 50]);
  });
});
