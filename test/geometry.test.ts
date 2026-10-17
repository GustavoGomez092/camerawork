import { describe, expect, test } from "bun:test";
import {
  applyH,
  homography,
  lookScale,
  mapRect,
  masterToScene,
  type Quad,
  sceneLayout,
  tiltQuad,
} from "../src/geometry.js";
import { LOOKS } from "../src/looks.js";

const near = (a: number[], b: number[], eps = 1e-6) => {
  for (const [i, v] of a.entries()) expect(Math.abs(v - (b[i] as number))).toBeLessThan(eps);
};

describe("homography", () => {
  test("maps the four source corners onto the destination corners", () => {
    const src: Quad = [
      [0, 0],
      [100, 0],
      [0, 50],
      [100, 50],
    ];
    const dst: Quad = [
      [10, 5],
      [90, 0],
      [0, 50],
      [100, 45],
    ];
    const h = homography(src, dst);
    for (const [i, p] of src.entries()) near(applyH(h, p), dst[i] as number[]);
  });

  test("is the identity for identical quads", () => {
    const q: Quad = [
      [0, 0],
      [10, 0],
      [0, 10],
      [10, 10],
    ];
    near(applyH(homography(q, q), [3, 7]), [3, 7]);
  });
});

describe("tiltQuad", () => {
  test("no tilt keeps the rectangle", () => {
    expect(tiltQuad(1920, 1080, { rotateX: 0, rotateY: 0, perspective: 2400 })).toEqual([
      [0, 0],
      [1920, 0],
      [0, 1080],
      [1920, 1080],
    ]);
  });

  test("rotateY makes the far (right) edge shorter, and the quad stays inside the box", () => {
    const q = tiltQuad(1920, 1080, { rotateX: 0, rotateY: 8, perspective: 2400 });
    const left = q[2][1] - q[0][1];
    const right = q[3][1] - q[1][1];
    expect(right).toBeLessThan(left);
    for (const [x, y] of q) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(1920 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(1080 + 1e-9);
    }
  });
});

describe("sceneLayout", () => {
  test("flat look on a same-aspect master: the scene is the master", () => {
    const l = sceneLayout({ width: 3840, height: 2160 }, LOOKS.flat, 16 / 9);
    expect(l).toMatchObject({ sceneW: 3840, sceneH: 2160, winX: 0, winY: 0, winW: 3840, winH: 2160 });
    expect(masterToScene(l, [100, 200])).toEqual([100, 200]);
  });

  test("hero look pads the window by 9 % and keeps it at 1:1 master pixels", () => {
    // 3840 / 0.82 = 4682.9 → 4683 → even 4684; 2160 / 0.82 = 2634.1 → 2635 → even 2636;
    // 4684 / 2636 < 16/9, so the width grows: 2636 × 16/9 = 4686.2 → 4687 → even 4688.
    const l = sceneLayout({ width: 3840, height: 2160 }, LOOKS.hero, 16 / 9);
    expect(l).toMatchObject({ winW: 3840, winH: 2160, sceneW: 4688, sceneH: 2636, winX: 424, winY: 238 });
  });

  test("odd masters give an even scene (Review Focus 2)", () => {
    const l = sceneLayout({ width: 1365, height: 767 }, LOOKS.hero, 1365 / 767);
    expect(l.sceneW % 2).toBe(0);
    expect(l.sceneH % 2).toBe(0);
  });

  test("a wider output aspect grows the scene sideways, keeping the window centered", () => {
    const l = sceneLayout({ width: 1000, height: 1000 }, LOOKS.flat, 2);
    expect(l).toMatchObject({ sceneW: 2000, sceneH: 1000, winX: 500, winY: 0 });
  });

  test("mapRect offsets by the window position", () => {
    const l = sceneLayout({ width: 1000, height: 1000 }, LOOKS.flat, 2);
    expect(mapRect(l, [10, 20, 30, 40])).toEqual([510, 20, 30, 40]);
  });

  test("lookScale is relative to a 1920 window", () => {
    expect(lookScale(3840)).toBe(2);
  });
});
