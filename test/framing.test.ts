import { describe, expect, test } from "bun:test";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS } from "../src/looks.js";
import { frameRect, unionRect, wideView, windowBox } from "../src/plan/framing.js";
import type { Look, Rect, View } from "../src/schema.js";

const layout = sceneLayout({ width: 1920, height: 1080 }, LOOKS.flat, 16 / 9);

describe("framing", () => {
  test("wide is the scene center at zoom 1", () => {
    expect(wideView(layout)).toEqual({ cx: 960, cy: 540, zoom: 1 });
  });

  test("a small target zooms in to the cap", () => {
    expect(frameRect([900, 500, 20, 20], layout, 0.12, 2.2)).toEqual({ cx: 910, cy: 510, zoom: 2.2 });
  });

  test("the margin sets the zoom: 480 px + 12 % each side = 595.2 px → zoom 3.23 (cap 4)", () => {
    expect(frameRect([0, 0, 480, 100], layout, 0.12, 4).zoom).toBeCloseTo(1920 / 595.2, 5);
  });

  test("a tall target is limited by height through the aspect ratio", () => {
    expect(frameRect([900, 0, 50, 900], layout, 0, 4).zoom).toBeCloseTo(1080 / 900, 5);
  });

  test("a target bigger than the scene stays wide", () => {
    expect(frameRect([0, 0, 1900, 1070], layout, 0.12, 2.2)).toEqual({ cx: 960, cy: 540, zoom: 1 });
  });

  test("the view is pushed inside the scene near an edge", () => {
    expect(frameRect([0, 0, 40, 40], layout, 0.12, 2)).toEqual({ cx: 480, cy: 270, zoom: 2 });
  });

  test("a zoom override is clamped to [1, maxZoom]", () => {
    expect(frameRect([900, 500, 20, 20], layout, 0.12, 2.2, 5).zoom).toBe(2.2);
    expect(frameRect([900, 500, 20, 20], layout, 0.12, 2.2, 1.5).zoom).toBe(1.5);
  });

  test("unionRect", () => {
    expect(unionRect([0, 0, 10, 10], [20, 5, 10, 10])).toEqual([0, 0, 30, 15]);
  });

  describe("zoomed views stay inside the app window (R-c)", () => {
    // hero: 3840×2160 master in a 4688×2636 scene, window at (424, 238).
    const hero = sceneLayout({ width: 3840, height: 2160 }, LOOKS.hero, 16 / 9);
    const inside = (v: View, [x, y, w, h]: Rect) => {
      const vw = hero.sceneW / v.zoom;
      const vh = hero.sceneH / v.zoom;
      expect(v.cx - vw / 2).toBeGreaterThanOrEqual(x - 1e-6);
      expect(v.cx + vw / 2).toBeLessThanOrEqual(x + w + 1e-6);
      expect(v.cy - vh / 2).toBeGreaterThanOrEqual(y - 1e-6);
      expect(v.cy + vh / 2).toBeLessThanOrEqual(y + h + 1e-6);
    };

    test("the window box is the window in scene pixels", () => {
      expect(windowBox(hero)).toEqual([424, 238, 3840, 2160]);
    });

    test("a target near the window's right or top edge is framed without showing the backdrop", () => {
      // The react tile: right edge at the window's right edge.
      const tile = frameRect([2588, 1438, 1676, 896], hero, 0.12, 1.83);
      expect(tile.zoom).toBeCloseTo(1.83, 6);
      inside(tile, windowBox(hero));
      const top = frameRect([1336, 262, 1920, 600], hero, 0.12, 1.83);
      inside(top, windowBox(hero));
    });

    test("a view larger than the window in a dimension is centred on the window there", () => {
      const v = frameRect([3900, 300, 300, 1900], hero, 0.12, 1.83);
      expect(v.zoom).toBeLessThan(hero.sceneH / hero.winH);
      expect(v.cy).toBeCloseTo(238 + 2160 / 2, 6);
      expect(v.cx).toBeCloseTo(424 + 3840 / 2, 6); // same aspect: larger in width too
    });

    test("wide is unchanged: the whole scene", () => {
      expect(frameRect([0, 0, 4600, 2600], hero, 0.12, 1.83)).toEqual(wideView(hero));
      expect(wideView(hero)).toEqual({ cx: 2344, cy: 1318, zoom: 1 });
    });

    test("a tilted window is bounded by its warped quad's bounding box", () => {
      const tilted: Look = { ...LOOKS.hero, tilt: { rotateX: 8, rotateY: -12, perspective: 2400 } };
      const t = sceneLayout({ width: 3840, height: 2160 }, tilted, 16 / 9);
      const xs = t.quad.map((q) => q[0] + t.winX);
      const ys = t.quad.map((q) => q[1] + t.winY);
      const box: Rect = [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
      ];
      expect(windowBox(t)).toEqual(box);
      inside(frameRect([box[0] + box[2] - 60, box[1] + 10, 50, 50], t, 0.12, 2.2), box);
    });
  });
});
