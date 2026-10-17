import { describe, expect, test } from "bun:test";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS } from "../src/looks.js";
import { frameRect, unionRect, wideView } from "../src/plan/framing.js";

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
});
