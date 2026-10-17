import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CameraworkError } from "../src/errors.js";
import { plan, readCueFile, readPlan, writeJsonAtomic } from "../src/plan/index.js";
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

  test("readCueFile names the file on invalid JSON", () => {
    const path = join(tmpDir(), "bad.json");
    writeFileSync(path, "{ nope");
    expect(() => readCueFile(path)).toThrow(`${path} is not valid JSON`);
  });
});
