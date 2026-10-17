import { describe, expect, test } from "bun:test";
import { CameraworkError, parseWith } from "../src/errors.js";
import { LOOKS, resolveLook } from "../src/looks.js";
import {
  CueFileSchema,
  DEFAULT_PLANNER,
  LookSchema,
  OutputSchema,
  PlannerParamsSchema,
  PlanSchema,
} from "../src/schema.js";

describe("cue files", () => {
  test("accept focus, wide and ignore cues, masks and planner overrides", () => {
    const file = {
      version: 1,
      masks: [[3700, 0, 140, 40]],
      planner: { maxZoom: 2 },
      cues: [
        { t: 3.2, rect: [1083, 26, 261, 57], zoom: 2, hold: 1.5, label: "filter chips" },
        { t: 8, wide: true },
        { from: 5, to: 6, ignore: true },
      ],
    };
    expect(parseWith(CueFileSchema, file, "cues.json").cues).toHaveLength(3);
  });

  test("reject unknown keys and a non-positive rect size", () => {
    expect(() => parseWith(CueFileSchema, { version: 1, cues: [{ t: 1, rect: [0, 0, 0, 5] }] }, "c")).toThrow(
      CameraworkError,
    );
    expect(() => parseWith(CueFileSchema, { version: 1, cues: [{ t: 1, wide: true, zoom: 2 }] }, "c")).toThrow(
      CameraworkError,
    );
  });
});

describe("planner defaults", () => {
  test("match the spec", () => {
    expect(DEFAULT_PLANNER).toEqual({
      margin: 0.12,
      maxZoom: 2.2,
      panZoomTolerance: 0.3,
      zoomOutGap: 1.0,
      anticipation: 0.35,
      minHold: 1.2,
      maxPanSpeed: 0.6,
      maxZoomRate: 1.5,
      idleWide: 2.5,
      shotJoinGap: 0.6,
    });
    expect(PlannerParamsSchema.safeParse(DEFAULT_PLANNER).success).toBe(true);
  });
});

describe("looks", () => {
  test("both built-in looks are valid", () => {
    for (const look of Object.values(LOOKS)) expect(LookSchema.safeParse(look).success).toBe(true);
  });

  test("hero is the measured preset (ruling R2)", () => {
    expect(LOOKS.hero.padding).toBe(0.09);
    expect(LOOKS.hero.radius).toBe(18);
    expect(LOOKS.hero.tilt).toEqual({ rotateX: 0, rotateY: 0, perspective: 2400 });
  });

  test("resolveLook returns a copy of a preset, validates an object, and rejects unknown names", () => {
    const hero = resolveLook("hero");
    hero.padding = 0.2;
    expect(LOOKS.hero.padding).toBe(0.09);
    expect(resolveLook({ ...LOOKS.flat, padding: 0.05 }).padding).toBe(0.05);
    expect(() => resolveLook("sparkly")).toThrow('unknown look "sparkly" (known: hero, flat)');
    expect(() => resolveLook({ ...LOOKS.flat, padding: 0.6 })).toThrow(CameraworkError);
  });
});

describe("hardening", () => {
  test("Object.prototype names are not looks", () => {
    for (const name of ["constructor", "__proto__", "toString"])
      expect(() => resolveLook(name)).toThrow(/unknown look/);
  });

  test("duplicate output formats are rejected", () => {
    const out = {
      width: 640,
      fps: 30,
      formats: ["mp4", "mp4"],
      poster: null,
      maxBytes: null,
      aspect: 1.5,
      quality: "medium",
    };
    expect(() => parseWith(OutputSchema, out, "output")).toThrow(CameraworkError);
  });
});

describe("plans", () => {
  const plan = {
    version: 1,
    master: { path: "m.mov", width: 1280, height: 720, fps: 30, duration: 5 },
    output: { width: 640, fps: 30, formats: ["mp4"], poster: null, maxBytes: null, aspect: 16 / 9, quality: "medium" },
    look: LOOKS.flat,
    planner: DEFAULT_PLANNER,
    maxZoom: 2,
    loop: false,
    scene: { width: 1280, height: 720 },
    shots: [],
    keyframes: [
      { t: 0, cx: 640, cy: 360, zoom: 1 },
      { t: 5, cx: 640, cy: 360, zoom: 1 },
    ],
  };

  test("a valid plan parses", () => {
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });

  test("keyframes must be in time order and the output width even", () => {
    const shuffled = { ...plan, keyframes: [...plan.keyframes].reverse() };
    expect(PlanSchema.safeParse(shuffled).success).toBe(false);
    expect(PlanSchema.safeParse({ ...plan, output: { ...plan.output, width: 641 } }).success).toBe(false);
  });
});
