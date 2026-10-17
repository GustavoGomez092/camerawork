import { describe, expect, test } from "bun:test";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS } from "../src/looks.js";
import type { PlanEvent } from "../src/plan/cues.js";
import { clusterShots } from "../src/plan/shots.js";
import { DEFAULT_PLANNER } from "../src/schema.js";

const layout = sceneLayout({ width: 1920, height: 1080 }, LOOKS.flat, 16 / 9);
const auto = (start: number, x: number, y = 500): PlanEvent => ({
  start,
  end: start + 1 / 15,
  rect: [x, y, 20, 20],
  source: "auto",
});

describe("clusterShots", () => {
  test("a typing burst along one line is one shot whose target grows", () => {
    // Glyphs 0.3 s apart: three moments (1.0+1.3, 1.6+1.9, 2.2), each joining the growing shot.
    const typing = [0, 0.3, 0.6, 0.9, 1.2].map((t, i) => auto(1 + t, 600 + i * 14));
    const shots = clusterShots(typing, layout, DEFAULT_PLANNER);
    expect(shots).toHaveLength(1);
    expect(shots[0]?.rect).toEqual([600, 500, 76, 20]);
    expect(shots[0]?.start).toBe(1);
  });

  test("a pause longer than shotJoinGap starts a new shot", () => {
    expect(clusterShots([auto(1, 600), auto(2, 620)], layout, DEFAULT_PLANNER)).toHaveLength(2);
  });

  test("a change far away (needing a much wider view) in the next moment starts a new shot even without a pause", () => {
    // Same moment (within shotJoinGap of 1.0) the far change would compete on salience instead (F2), so it comes at 1.7.
    const events = [auto(1, 100, 100), auto(1.3, 120, 100), auto(1.7, 1700, 900)];
    expect(clusterShots(events, layout, DEFAULT_PLANNER)).toHaveLength(2);
  });

  test("cues are always their own shot, with their zoom override", () => {
    const cue: PlanEvent = { start: 1.05, end: 3, rect: [600, 500, 40, 20], source: "cue", zoom: 1.5 };
    const shots = clusterShots([auto(1, 600), cue], layout, DEFAULT_PLANNER);
    expect(shots).toHaveLength(2);
    expect(shots[1]).toMatchObject({ source: "cue", view: { zoom: 1.5 } });
  });

  test("wide events become wide shots", () => {
    const shots = clusterShots(
      [{ start: 2, end: 3, rect: [0, 0, 1, 1], source: "cue", wide: true }],
      layout,
      DEFAULT_PLANNER,
    );
    expect(shots[0]?.view).toEqual({ cx: 960, cy: 540, zoom: 1 });
  });

  test("one UI update touching far-apart regions is one shot on the most salient region (F2)", () => {
    const at = (x: number, y: number, w: number, h: number, weight: number): PlanEvent => ({
      start: 1,
      end: 1 + 1 / 15,
      rect: [x, y, w, h],
      source: "auto",
      weight,
    });
    const shots = clusterShots(
      [at(10, 10, 20, 20, 300), at(1880, 10, 20, 20, 300), at(1200, 600, 400, 400, 140000), at(10, 1050, 20, 20, 300)],
      layout,
      DEFAULT_PLANNER,
    );
    expect(shots).toHaveLength(1);
    expect(shots[0]?.rect).toEqual([1200, 600, 400, 400]);
  });

  test("tiny simultaneous corner changes become one shot, not a tour; a later panel is its own shot (F2)", () => {
    const tiny = (x: number, y: number): PlanEvent => ({
      start: 0.4,
      end: 0.4 + 1 / 15,
      rect: [x, y, 60, 60],
      source: "auto",
      weight: 1800,
    });
    const panel: PlanEvent = {
      start: 2.3,
      end: 2.3 + 1 / 15,
      rect: [1200, 600, 400, 400],
      source: "auto",
      weight: 150000,
    };
    const shots = clusterShots([tiny(50, 50), tiny(1800, 50), tiny(50, 1000), panel], layout, DEFAULT_PLANNER);
    expect(shots).toHaveLength(2);
    expect(shots[1]?.rect).toEqual([1200, 600, 400, 400]);
  });

  test("a typing burst outweighs a heavier single status-bar update in the same moment (F2)", () => {
    const glyphs = [0, 1, 2, 3, 4, 5].map((i): PlanEvent => ({ ...auto(1 + i * 0.1, 600 + i * 14), weight: 300 }));
    const status: PlanEvent = { start: 1, end: 1 + 1 / 15, rect: [1700, 1060, 20, 16], source: "auto", weight: 320 };
    const shots = clusterShots([status, ...glyphs], layout, DEFAULT_PLANNER);
    expect(shots).toHaveLength(1);
    // One moment: the glyph group wins on summed weight and is framed on its first (dominant) glyph (R-a).
    expect(shots[0]?.rect).toEqual([600, 500, 20, 20]);
  });

  test("cues are never dropped or merged by salience (F2)", () => {
    const cue: PlanEvent = { start: 1, end: 3, rect: [10, 10, 20, 20], source: "cue" };
    const big: PlanEvent = { start: 1, end: 1 + 1 / 15, rect: [1200, 600, 400, 400], source: "auto", weight: 150000 };
    const shots = clusterShots([big, cue], layout, DEFAULT_PLANNER);
    expect(shots.filter((s) => s.source === "cue")).toEqual([
      expect.objectContaining({ start: 1, end: 3, rect: [10, 10, 20, 20] }),
    ]);
  });

  describe("one moment is framed on its dominant region (R-a)", () => {
    const at = (x: number, y: number, w: number, h: number, weight: number): PlanEvent => ({
      start: 1,
      end: 1 + 1 / 15,
      rect: [x, y, w, h],
      source: "auto",
      weight,
    });
    // A centred panel: framed alone at zoom ~1.74, its view spans x 399..1501, y 240..860 (flat 1920×1080 scene).
    const panel = at(600, 300, 700, 500, 350000);

    test("a small region outside the panel's framed view does not drag the centre", () => {
      const shots = clusterShots([panel, at(1550, 500, 20, 20, 400)], layout, DEFAULT_PLANNER);
      expect(shots).toHaveLength(1);
      expect(shots[0]?.view.cx).toBeCloseTo(950, 0);
      expect(shots[0]?.view.cy).toBeCloseTo(550, 0);
      expect(shots[0]?.rect).toEqual([600, 300, 700, 500]);
    });

    test("a small region inside the panel's framed view does not move the centre either", () => {
      const shots = clusterShots([panel, at(1400, 500, 20, 20, 400)], layout, DEFAULT_PLANNER);
      expect(shots).toHaveLength(1);
      expect(shots[0]?.view.cx).toBeCloseTo(950, 0);
      expect(shots[0]?.view.cy).toBeCloseTo(550, 0);
    });
  });

  test("a next moment outside the current shot's view starts a new shot, even when the union would frame close (R-a)", () => {
    // An output panel (framed at 2.2: x 914..1786), then typing far left 0.4 s later. Their union would frame at
    // ~1.94, within panZoomTolerance, but the typing is not where the camera is looking: it is its own shot.
    const panel: PlanEvent = { start: 1, end: 1 + 1 / 15, rect: [1200, 300, 300, 200], source: "auto", weight: 60000 };
    const typing = [1.5, 1.6, 1.7].map((t, i): PlanEvent => ({ ...auto(t, 700 + i * 14, 320), weight: 300 }));
    const shots = clusterShots([panel, ...typing], layout, DEFAULT_PLANNER);
    expect(shots).toHaveLength(2);
    expect(shots[0]?.rect).toEqual([1200, 300, 300, 200]);
  });
});
