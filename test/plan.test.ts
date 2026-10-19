import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CameraworkError } from "../src/errors.js";
import { plan, readCueFile, readPlan, writeJsonAtomic } from "../src/plan/index.js";
import type { ChangesFile } from "../src/schema.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

describe("plan", () => {
  test("frames a box that appears, and records every setting used", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, {
      width: 1280,
      height: 720,
      fps: 30,
      seconds: 6,
      boxes: [{ x: 200, y: 150, size: 80, from: 2, to: 6 }],
    });
    const p = await plan(master, { look: "flat", output: { width: 640 } });
    expect(p.scene).toEqual({ width: 1280, height: 720 });
    expect(p.maxZoom).toBe(2); // 1280 / 640 caps the default 2.2 (ruling R5)
    expect(p.shots.length).toBeGreaterThanOrEqual(1);
    const framed = p.keyframes.find((k) => k.zoom > 1);
    expect(framed?.cx).toBeLessThan(640);
    expect(p.output).toMatchObject({ width: 640, fps: 30, formats: ["mp4", "webm"], poster: "jpg", quality: "medium" });
    writeJsonAtomic(join(dir, "plan.json"), p);
    expect(readPlan(join(dir, "plan.json"))).toEqual(p);
  });

  test("no changes → wide keyframes only (Review Focus 3)", async () => {
    const master = join(tmpDir(), "still.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 3, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640 } });
    expect(p.shots).toEqual([]);
    expect(p.keyframes.every((k) => k.zoom === 1)).toBe(true);
  });

  test("an output wider than the scene is refused, naming the fix", async () => {
    const master = join(tmpDir(), "small.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    await expect(plan(master, { look: "flat", output: { width: 1280 } })).rejects.toThrow("Use --width 640 or less");
  });

  test("a cue past the end is rejected", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 2, boxes: [] });
    writeFileSync(join(dir, "cues.json"), JSON.stringify({ version: 1, cues: [{ t: 9, wide: true }] }));
    const cues = readCueFile(join(dir, "cues.json"));
    await expect(plan(master, { cues, look: "flat", output: { width: 640 } })).rejects.toThrow(CameraworkError);
  });

  test("a poster cue picks the poster's moment; --poster-at wins; past the end is refused", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 3, boxes: [] });
    writeFileSync(join(dir, "cues.json"), JSON.stringify({ version: 1, cues: [{ t: 2.5, poster: true }] }));
    const cues = readCueFile(join(dir, "cues.json"));
    expect((await plan(master, { look: "flat", output: { width: 640 } })).output.posterAt).toBe(0);
    expect((await plan(master, { cues, look: "flat", output: { width: 640 } })).output.posterAt).toBe(2.5);
    expect((await plan(master, { cues, look: "flat", output: { width: 640, posterAt: 1 } })).output.posterAt).toBe(1);
    await expect(plan(master, { look: "flat", output: { width: 640, posterAt: 9 } })).rejects.toThrow(
      "--poster-at 9 is after the end of the video (3.00 s)",
    );
  });

  test("readCueFile names the file on invalid JSON", () => {
    const path = join(tmpDir(), "bad.json");
    writeFileSync(path, "{ nope");
    expect(() => readCueFile(path)).toThrow(`${path} is not valid JSON`);
  });
  test("a changes file from a different-size video is rejected", async () => {
    const master = join(tmpDir(), "m.mp4");
    await makeBoxVideo(master, { width: 1280, height: 720, fps: 30, seconds: 2, boxes: [] });
    const changes: ChangesFile = {
      version: 1,
      master: { path: "x.mp4", width: 640, height: 360, fps: 30, duration: 2 },
      changes: [],
    };
    const err = await plan(master, { changes, look: "flat", output: { width: 640 } }).catch((e) => e);
    expect(err).toBeInstanceOf(CameraworkError);
    expect(err.message).toContain("640x360");
    expect(err.message).toContain("1280x720");
  });

  test("masks from options and from the cue file both reach detection", async () => {
    const master = join(tmpDir(), "m.mp4");
    await makeBoxVideo(master, {
      width: 1280,
      height: 720,
      fps: 30,
      seconds: 8,
      boxes: [
        { x: 100, y: 100, size: 100, from: 1, to: 3 },
        { x: 900, y: 450, size: 100, from: 5, to: 7 },
      ],
    });
    const control = await plan(master, { look: "flat", output: { width: 640 } });
    expect(control.shots.length).toBeGreaterThanOrEqual(2);
    const masked = await plan(master, {
      masks: [[80, 80, 140, 140]],
      cues: { version: 1, masks: [[880, 430, 140, 140]], cues: [] },
      look: "flat",
      output: { width: 640 },
    });
    expect(masked.shots).toEqual([]);
  });

  test("planner precedence, and given changes skip detection", async () => {
    const master = join(tmpDir(), "m.mp4");
    await makeBoxVideo(master, { width: 1280, height: 720, fps: 30, seconds: 6, boxes: [] });
    const changes: ChangesFile = {
      version: 1,
      master: { path: master, width: 1280, height: 720, fps: 30, duration: 6 },
      changes: [{ t: 2, rect: [200, 150, 80, 80], strength: 1 }],
    };
    const base = { changes, look: "flat", output: { width: 640 } };
    const both = await plan(master, {
      ...base,
      cues: { version: 1, planner: { minHold: 2 }, cues: [] },
      planner: { minHold: 3 },
    });
    expect(both.planner.minHold).toBe(3);
    const cueOnly = await plan(master, { ...base, cues: { version: 1, planner: { minHold: 2 }, cues: [] } });
    expect(cueOnly.planner.minHold).toBe(2);
    expect(cueOnly.shots.length).toBe(1); // from the given file; the video itself has no changes
  });
});
