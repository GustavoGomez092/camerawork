import { describe, expect, test } from "bun:test";
import { CameraworkError } from "../src/errors.js";
import { toEvents, validateCues } from "../src/plan/cues.js";
import type { Change, CueFile } from "../src/schema.js";

const master = { path: "m.mov", width: 1920, height: 1080, fps: 30, duration: 10 };
const change = (t: number, x = 10): Change => ({ t, rect: [x, 10, 50, 50], strength: 1 });

describe("validateCues", () => {
  test("names the cue that is out of range", () => {
    const file: CueFile = {
      version: 1,
      cues: [
        { t: 1, wide: true },
        { t: 12, rect: [0, 0, 10, 10], label: "late" },
      ],
    };
    expect(() => validateCues(file, master)).toThrow('cue 1 ("late"): t=12 is after the end of the video (10.00 s)');
  });

  test("rejects a rect outside the video and an empty ignore range", () => {
    expect(() => validateCues({ version: 1, cues: [{ t: 1, rect: [1900, 0, 50, 10] }] }, master)).toThrow(
      CameraworkError,
    );
    expect(() => validateCues({ version: 1, cues: [{ from: 3, to: 3, ignore: true }] }, master)).toThrow(
      'cue 0: "from" must be before "to"',
    );
  });
});

describe("toEvents", () => {
  test("auto changes become events lasting one analysis frame", () => {
    expect(toEvents([change(2)], undefined, 1.2, 1 / 15)).toEqual([
      { start: 2, end: 2 + 1 / 15, rect: [10, 10, 50, 50], source: "auto", weight: 2500 },
    ]);
  });

  test("auto events carry their changed-pixel count as weight (strength × area, master pixels)", () => {
    const [e] = toEvents([{ t: 1, rect: [0, 0, 40, 50], strength: 0.5 }], undefined, 1.2, 1 / 15);
    expect(e?.weight).toBe(1000);
  });

  test("a cue wins inside its window and ignore ranges drop changes", () => {
    const cues: CueFile = {
      version: 1,
      cues: [
        { t: 1, rect: [500, 500, 100, 100], hold: 2, zoom: 1.8 },
        { from: 5, to: 6, ignore: true },
        { t: 8, wide: true },
      ],
    };
    const events = toEvents([change(1.5), change(4), change(5.5), change(8.5)], cues, 1.2, 1 / 15);
    expect(events.map((e) => [e.start, e.source, e.wide ?? false])).toEqual([
      [1, "cue", false],
      [4, "auto", false],
      [8, "cue", true],
    ]);
    expect(events[0]).toMatchObject({ end: 3, zoom: 1.8 });
    expect(events[2]?.end).toBeCloseTo(9.2);
  });

  test("full-frame changes become wide events", () => {
    const full: Change = { t: 3, rect: [0, 0, 1920, 1080], strength: 1, fullFrame: true };
    expect(toEvents([full], undefined, 1.2, 1 / 15)[0]?.wide).toBe(true);
  });
});
