import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { CameraworkError } from "../src/errors.js";
import { probe, readFrames } from "../src/ffmpeg.js";
import { plan } from "../src/plan/index.js";
import { checkSharpness, render } from "../src/render/index.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

/** Centroid of strongly red pixels in the output frame at time t. */
async function redCentroid(video: string, t: number, w: number, h: number): Promise<[number, number]> {
  let result: [number, number] = [-1, -1];
  await readFrames(["-ss", String(t), "-i", video, "-frames:v", "1", "-pix_fmt", "rgb24"], w * h * 3, (f) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        if ((f[i] as number) > 150 && (f[i + 1] as number) < 90 && (f[i + 2] as number) < 90) {
          sx += x;
          sy += y;
          n++;
        }
      }
    result = n ? [sx / n, sy / n] : [-1, -1];
  });
  return result;
}

/** How many strongly red pixels an image file has (a poster). */
async function redPixels(path: string): Promise<number> {
  const image = await loadImage(path);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  let n = 0;
  for (let i = 0; i < data.length; i += 4)
    if ((data[i] as number) > 150 && (data[i + 1] as number) < 90 && (data[i + 2] as number) < 90) n++;
  return n;
}

describe("render (end to end)", () => {
  test("the camera centers each box while it holds on it (Review Focus 5: paths with spaces)", async () => {
    const dir = tmpDir("camerawork e2e ");
    const master = join(dir, "boxes master.mp4");
    // Boxes sit away from the edges: at zoom 2 the camera cannot center anything within 320×180 px of an edge.
    await makeBoxVideo(master, {
      width: 1280,
      height: 720,
      fps: 30,
      seconds: 8,
      boxes: [
        { x: 400, y: 250, size: 80, from: 1, to: 3.6 },
        { x: 800, y: 400, size: 80, from: 4.5, to: 8 },
      ],
    });
    const p = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4"], poster: "jpg" }, loop: true });
    const files = await render(p, { out: join(dir, "out clip") });
    expect(files.sort()).toEqual([join(dir, "out clip.jpg"), join(dir, "out clip.mp4")]);
    const info = probe(join(dir, "out clip.mp4"));
    expect([info.width, info.height]).toEqual([640, 360]);
    expect(info.duration).toBeCloseTo(8, 0);
    // 2.6 s: holding on box 1. 5.5 s: holding on box 2 (the loop's return to wide starts at ~6.3 s).
    for (const t of [2.6, 5.5]) {
      const [cx, cy] = await redCentroid(join(dir, "out clip.mp4"), t, 640, 360);
      expect(Math.abs(cx - 320)).toBeLessThan(64);
      expect(Math.abs(cy - 180)).toBeLessThan(48);
    }
    expect(readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  test("the poster is the frame at posterAt, not the first frame", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    // A red box exists only from 2 s to 3 s: a first-frame poster has none of it.
    await makeBoxVideo(master, {
      width: 1280,
      height: 720,
      fps: 30,
      seconds: 3,
      boxes: [{ x: 600, y: 320, size: 80, from: 2, to: 3 }],
    });
    const first = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4"], poster: "jpg" } });
    await render(first, { out: join(dir, "first") });
    expect(await redPixels(join(dir, "first.jpg"))).toBe(0);
    const later = await plan(master, {
      look: "flat",
      output: { width: 640, formats: ["mp4"], poster: "jpg", posterAt: 2.5 },
    });
    await render(later, { out: join(dir, "later") });
    expect(await redPixels(join(dir, "later.jpg"))).toBeGreaterThan(500);
  });

  test("a hand-edited plan that would upscale is refused before rendering", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4"], poster: null } });
    (p.keyframes[0] as (typeof p.keyframes)[number]).zoom = 2;
    expect(() => checkSharpness(p)).toThrow(CameraworkError);
    await expect(render(p, { out: join(dir, "o") })).rejects.toThrow("would upscale");
    expect(existsSync(join(dir, "o.mp4"))).toBe(false);
  });

  test("maxBytes fails the render and leaves no file", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, {
      width: 640,
      height: 360,
      fps: 30,
      seconds: 2,
      boxes: [{ x: 10, y: 10, size: 50, from: 0.5, to: 2 }],
    });
    const p = await plan(master, {
      look: "flat",
      output: { width: 640, formats: ["mp4"], poster: null, maxBytes: 100 },
    });
    await expect(render(p, { out: join(dir, "o") })).rejects.toThrow("larger than the 100-byte limit");
    expect(existsSync(join(dir, "o.mp4"))).toBe(false);
  });

  test("over maxBytes, the render steps the encoder quality down until it fits", async () => {
    const dir = tmpDir();
    const master = join(dir, "busy.mp4");
    // A moving test pattern: unlike flat boxes, its size really depends on the encoder's quality.
    spawnSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30",
      "-t",
      "2",
      "-pix_fmt",
      "yuv420p",
      master,
    ]);
    const free = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4"], poster: null } });
    await render(free, { out: join(dir, "free") });
    const natural = statSync(join(dir, "free.mp4")).size;
    const limit = Math.floor(natural * 0.75);
    const capped = await plan(master, {
      look: "flat",
      output: { width: 640, formats: ["mp4"], poster: null, maxBytes: limit },
    });
    await render(capped, { out: join(dir, "capped") });
    expect(statSync(join(dir, "capped.mp4")).size).toBeLessThanOrEqual(limit);
    expect(probe(join(dir, "capped.mp4")).duration).toBeCloseTo(2, 0);
  });

  test("checkSharpness names the plan's maxZoom when only that is exceeded", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 320, formats: ["mp4"], poster: null } });
    p.maxZoom = 1.5;
    (p.keyframes[0] as (typeof p.keyframes)[number]).zoom = 1.8; // 320 * 1.8 < 640: sharp, but over maxZoom
    expect(() => checkSharpness(p)).toThrow(CameraworkError);
    expect(() => checkSharpness(p)).toThrow("maxZoom of 1.5");
  });

  // pgrep -P lists direct children of this test process: any ffmpeg left behind is an orphaned encoder.
  const childFfmpegs = () =>
    spawnSync("pgrep", ["-P", String(process.pid), "ffmpeg"], { encoding: "utf8" }).stdout.trim();

  test("a dead encoder (output in a missing directory) rejects instead of hanging", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 2, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4", "webm"], poster: null } });
    await expect(render(p, { out: join(dir, "no such dir", "o") })).rejects.toThrow(CameraworkError);
    expect(readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
    expect(childFfmpegs()).toBe("");
  }, 15000);

  test("a master that disappears after planning rejects and leaves nothing running", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 2, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4", "webm"], poster: "jpg" } });
    rmSync(master);
    await expect(render(p, { out: join(dir, "o") })).rejects.toThrow(CameraworkError);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-") || f.startsWith("o."))).toEqual([]);
    expect(childFfmpegs()).toBe("");
  }, 15000);

  test("a deleted master is named in the error before any encoder starts", async () => {
    const dir = tmpDir();
    const master = join(dir, "gone.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4"], poster: null } });
    rmSync(master);
    await expect(render(p, { out: join(dir, "o") })).rejects.toThrow(master);
    await expect(render(p, { out: join(dir, "o") })).rejects.toThrow("master");
  });

  test("a swapped master of another size names both sizes", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4"], poster: null } });
    await makeBoxVideo(master, { width: 800, height: 600, fps: 30, seconds: 1, boxes: [] });
    const err = await render(p, { out: join(dir, "o") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraworkError);
    expect((err as Error).message).toContain("640x360");
    expect((err as Error).message).toContain("800x600");
    expect((err as Error).message).toContain(master);
    expect(readdirSync(dir).filter((f) => f.startsWith("o"))).toEqual([]);
  });

  test("a poster write failure is a CameraworkError and leaves no temps", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4"], poster: "jpg" } });
    mkdirSync(join(dir, `o.tmp-${process.pid}.jpg`)); // the poster's temp name is a directory: writing it fails
    const err = await render(p, { out: join(dir, "o") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraworkError);
    expect((err as Error).message).toContain("poster");
    expect(readdirSync(dir).filter((f) => f.endsWith(".mp4") && f.startsWith("o"))).toEqual([]);
    expect(childFfmpegs()).toBe("");
  }, 15000);
});
