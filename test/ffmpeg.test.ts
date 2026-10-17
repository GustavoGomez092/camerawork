import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CameraworkError } from "../src/errors.js";
import { FrameSink, hasEncoder, probe, readFrames, requireFfmpeg } from "../src/ffmpeg.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

describe("ffmpeg adapters", () => {
  test("requireFfmpeg passes on this machine", () => {
    expect(() => requireFfmpeg()).not.toThrow();
  });

  test("probe reads size, frame rate and duration (60 fps master)", async () => {
    const path = join(tmpDir(), "m.mp4");
    await makeBoxVideo(path, { width: 320, height: 180, fps: 60, seconds: 2, boxes: [] });
    const p = probe(path);
    expect(p).toMatchObject({ path, width: 320, height: 180, fps: 60 });
    expect(p.duration).toBeCloseTo(2, 1);
  });

  test("probe of a missing file is a CameraworkError", () => {
    expect(() => probe("/nope/missing.mov")).toThrow(CameraworkError);
  });

  test("readFrames delivers whole frames in order, even across pipe chunk boundaries", async () => {
    const path = join(tmpDir(), "m.mp4");
    await makeBoxVideo(path, { width: 320, height: 180, fps: 30, seconds: 1, boxes: [] });
    const seen: number[] = [];
    const count = await readFrames(["-i", path, "-vf", "fps=10,format=gray", "-pix_fmt", "gray"], 320 * 180, (f, i) => {
      expect(f.length).toBe(320 * 180);
      seen.push(i);
    });
    expect(count).toBe(10);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("FrameSink encodes raw frames and reports ffmpeg failures", async () => {
    const out = join(tmpDir(), "out.mp4");
    const raw = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", "64x36", "-r", "10", "-i", "-"];
    const sink = new FrameSink([...raw, "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
    const frame = Buffer.alloc(64 * 36 * 4, 200);
    for (let i = 0; i < 10; i++) await sink.write(frame);
    await sink.end();
    expect(probe(out).width).toBe(64);
    const bad = new FrameSink([...raw, "-c:v", "no-such-codec", out]);
    await expect(bad.end()).rejects.toThrow(CameraworkError);
  });

  test("hasEncoder finds libx264", () => {
    expect(hasEncoder("libx264")).toBe(true);
    expect(hasEncoder("definitely-not-an-encoder")).toBe(false);
  });

  test("FrameSink.write rejects instead of hanging when the encoder dies", async () => {
    const raw = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", "64x36", "-r", "10", "-i", "-"];
    const sink = new FrameSink([...raw, "-c:v", "no-such-codec", join(tmpDir(), "bad.mp4")]);
    const frame = Buffer.alloc(64 * 36 * 4, 200);
    const run = async () => {
      for (let i = 0; i < 200; i++) await sink.write(frame);
      await sink.end();
    };
    await expect(run()).rejects.toThrow(CameraworkError);
  }, 3000);
});
