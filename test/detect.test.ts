import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { detect } from "../src/detect/index.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

describe("detect", () => {
  test("finds each box when it appears, in master pixels, from a 60 fps master (Review Focus 1)", async () => {
    const path = join(tmpDir(), "boxes.mp4");
    await makeBoxVideo(path, {
      width: 1280,
      height: 720,
      fps: 60,
      seconds: 4,
      boxes: [
        { x: 160, y: 120, size: 96, from: 1, to: 4 },
        { x: 960, y: 520, size: 96, from: 2.5, to: 4 },
      ],
    });
    const result = await detect(path);
    expect(result.master).toMatchObject({ width: 1280, height: 720, fps: 60 });
    const first = result.changes.find((c) => Math.abs(c.t - 1) < 0.1);
    const second = result.changes.find((c) => Math.abs(c.t - 2.5) < 0.1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const [x1, y1, w1, h1] = first?.rect ?? [0, 0, 0, 0];
    expect(x1).toBeGreaterThan(140);
    expect(x1).toBeLessThan(180);
    expect(y1).toBeGreaterThan(100);
    expect(y1).toBeLessThan(140);
    expect(w1).toBeGreaterThan(80);
    expect(h1).toBeGreaterThan(80);
    expect(second?.rect[0]).toBeGreaterThan(930);
  });

  test("masked areas produce no changes", async () => {
    const path = join(tmpDir(), "boxes.mp4");
    await makeBoxVideo(path, {
      width: 640,
      height: 360,
      fps: 30,
      seconds: 2,
      boxes: [{ x: 40, y: 40, size: 60, from: 1, to: 2 }],
    });
    const result = await detect(path, { masks: [[0, 0, 200, 200]] });
    expect(result.changes).toEqual([]);
  });

  test("a change covering most of the frame is one full-frame change", async () => {
    const path = join(tmpDir(), "flash.mp4");
    await makeBoxVideo(path, {
      width: 640,
      height: 360,
      fps: 30,
      seconds: 2,
      boxes: [{ x: 0, y: 0, size: 640, from: 1, to: 2, color: "white" }],
    });
    const result = await detect(path);
    const flash = result.changes.filter((c) => Math.abs(c.t - 1) < 0.1);
    expect(flash).toHaveLength(1);
    expect(flash[0]).toMatchObject({ rect: [0, 0, 640, 360], fullFrame: true });
  });
});
