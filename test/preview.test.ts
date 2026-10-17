import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { CameraworkError } from "../src/errors.js";
import { probe } from "../src/ffmpeg.js";
import { plan } from "../src/plan/index.js";
import { preview } from "../src/preview.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

describe("preview", () => {
  test("writes a contact sheet (6 columns of 480 px) and a 960-px debug video", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, {
      width: 1280,
      height: 720,
      fps: 30,
      seconds: 3,
      boxes: [{ x: 500, y: 300, size: 80, from: 1, to: 3 }],
    });
    const p = await plan(master, { look: "hero", output: { width: 640 } });
    const { sheet, debug } = await preview(p, { out: join(dir, "plan") });
    const img = await loadImage(sheet);
    expect(img.width).toBe(6 * 480);
    expect(img.height).toBeGreaterThan(0);
    expect(probe(debug).width).toBe(960);
  });

  test("the sheet tile covering a short auto shot shows its red box", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 1280, height: 720, fps: 30, seconds: 3, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640 } });
    // 0.07 s, entirely between the tile times 0.5 and 1.0
    p.shots = [
      { start: 0.6, end: 0.67, rect: [400, 250, 200, 100], view: { cx: 500, cy: 300, zoom: 2 }, source: "auto" },
    ];
    const { sheet } = await preview(p, { out: join(dir, "plan") });
    const img = await loadImage(sheet);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    // scene 1280 → debug 960 → tile 480: scale 0.375. Tile 1 (t 0.5–1.0) is column 1.
    const redIn = (tile: number, x0: number, y0: number, x1: number, y1: number): number => {
      const ox = (tile % 6) * 480;
      const d = ctx.getImageData(ox + x0, y0, x1 - x0, y1 - y0).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if ((d[i] as number) > 200 && (d[i + 1] as number) < 120) n++;
      return n;
    };
    expect(redIn(1, 146, 90, 230, 135)).toBeGreaterThan(20);
    expect(redIn(0, 146, 90, 230, 135)).toBe(0);
    expect(redIn(2, 146, 90, 230, 135)).toBe(0);
  });

  test("a master that disappears leaves neither final files nor temps", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640 } });
    rmSync(master);
    await expect(preview(p, { out: join(dir, "plan") })).rejects.toThrow(master);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a failure after the debug video is encoded leaves no partial files", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640 } });
    mkdirSync(join(dir, `plan-sheet.tmp-${process.pid}.png`)); // the sheet's temp name is a directory: writing it fails
    await expect(preview(p, { out: join(dir, "plan") })).rejects.toThrow(CameraworkError);
    expect(readdirSync(dir).filter((f) => f.startsWith("plan"))).toEqual([]);
  });
});
