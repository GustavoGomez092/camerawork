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
    const typing = [0, 0.1, 0.2, 0.3, 0.4].map((t, i) => auto(1 + t, 600 + i * 14));
    const shots = clusterShots(typing, layout, DEFAULT_PLANNER);
    expect(shots).toHaveLength(1);
    expect(shots[0]?.rect).toEqual([600, 500, 76, 20]);
    expect(shots[0]?.start).toBe(1);
  });

  test("a pause longer than shotJoinGap starts a new shot", () => {
    expect(clusterShots([auto(1, 600), auto(2, 620)], layout, DEFAULT_PLANNER)).toHaveLength(2);
  });

  test("a change far away (needing a much wider view) starts a new shot even without a pause", () => {
    expect(clusterShots([auto(1, 100, 100), auto(1.1, 1700, 900)], layout, DEFAULT_PLANNER)).toHaveLength(2);
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
});
