import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fieldSize } from "../src/backdrops/field.js";
import { shaderField } from "../src/backdrops/index.js";
import { BACKDROPS } from "../src/backdrops/presets.js";
import { probe, readFrames } from "../src/ffmpeg.js";
import { motionFilter, motionFrameCount, renderBackdropVideo, shaderCanvas } from "../src/render/backdrop.js";
import { renderFrames } from "../src/render/backdrop-frames.js";
import type { ShaderBackdrop } from "../src/schema.js";
import { tmpDir } from "./helpers.js";
import { mad } from "./style-helpers.js";

const ultraviolet = BACKDROPS.ultraviolet?.backdrop as ShaderBackdrop;
const moving = (more: Partial<ShaderBackdrop> = {}): ShaderBackdrop => ({
  ...ultraviolet,
  grain: 0,
  motion: { enabled: true, speed: 1 },
  ...more,
});

/** Every frame of a video as RGBA. */
async function decode(path: string, w: number, h: number): Promise<Uint8ClampedArray[]> {
  const frames: Uint8ClampedArray[] = [];
  await readFrames(["-i", path, "-pix_fmt", "rgba"], w * h * 4, (f) => {
    frames.push(new Uint8ClampedArray(Buffer.from(f)));
  });
  return frames;
}

describe("still shader backdrops", () => {
  test("shaderCanvas has the requested size, is deterministic, and its grain is crisp", () => {
    const a = shaderCanvas(ultraviolet, 640, 360).data();
    expect(a.length).toBe(640 * 360 * 4);
    expect(a.equals(shaderCanvas(ultraviolet, 640, 360).data())).toBe(true);
    const smooth = shaderCanvas({ ...ultraviolet, grain: 0 }, 640, 360).data();
    let jumps = 0;
    for (let i = 4; i < 640 * 4; i += 4) {
      if (Math.abs((a[i] as number) - (a[i - 4] as number)) > 3) jumps++;
      expect(Math.abs((smooth[i] as number) - (smooth[i - 4] as number))).toBeLessThanOrEqual(3);
    }
    expect(jumps).toBeGreaterThan(100);
  });

  test("a huge master's scene (8K) renders from a ≤1280-px field without running out of memory (Review Focus 1)", () => {
    const before = process.memoryUsage().rss;
    const canvas = shaderCanvas(ultraviolet, 9368, 5272);
    expect([canvas.width, canvas.height]).toEqual([9368, 5272]);
    expect(fieldSize(9368, 5272)).toEqual([1280, 720]);
    // the scene canvas and one getImageData copy: about 2 × 198 MB
    expect(process.memoryUsage().rss - before).toBeLessThan(1.2e9);
  }, 60_000);
});

describe("animated shader backdrops", () => {
  test("motionFrameCount: duration × fps, at least one frame (Review Focus 3)", () => {
    expect(motionFrameCount(2, 30)).toBe(60);
    expect(motionFrameCount(0.01, 30)).toBe(1);
    expect(motionFrameCount(1.49, 2)).toBe(3);
  });

  test("renderFrames returns every frame, in order, equal to the field at t = i / frames", async () => {
    const bd = moving();
    for (const threads of [1, 3]) {
      const seen: number[] = [];
      await renderFrames(
        bd,
        64,
        36,
        7,
        (i, px) => {
          seen.push(i);
          expect(Buffer.from(px).equals(Buffer.from(shaderField(bd, 64, 36, i / 7)))).toBe(true);
        },
        threads,
      );
      expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  test("renderFrames rejects when a worker fails, and when onFrame fails", async () => {
    const broken = { ...moving(), style: "plaid" } as unknown as ShaderBackdrop;
    await expect(renderFrames(broken, 16, 16, 3, () => {})).rejects.toThrow();
    await expect(
      renderFrames(moving(), 16, 16, 3, () => {
        throw new Error("sink died");
      }),
    ).rejects.toThrow("sink died");
  });

  test("renderFrames stops calling onFrame once it has rejected", async () => {
    const calls: number[] = [];
    await expect(
      renderFrames(
        moving(),
        32,
        18,
        40,
        async (i) => {
          calls.push(i);
          await new Promise((r) => setTimeout(r, 5));
          if (i === 2) throw new Error("sink died at 2");
        },
        4,
      ),
    ).rejects.toThrow("sink died at 2");
    const seen = calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(seen);
    expect(Math.max(...calls)).toBeLessThan(40);
  }, 20_000);

  test("renderFrames resolves for 0 frames and rejects a non-integer count; motionFrameCount rejects NaN", async () => {
    let n = 0;
    await renderFrames(moving(), 16, 16, 0, () => {
      n++;
    });
    expect(n).toBe(0);
    await expect(renderFrames(moving(), 16, 16, Number.NaN, () => {})).rejects.toThrow(RangeError);
    await expect(renderFrames(moving(), 16, 16, 2.5, () => {})).rejects.toThrow(RangeError);
    expect(() => motionFrameCount(Number.NaN, 30)).toThrow(RangeError);
    expect(() => motionFrameCount(2, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  test("the intermediate video is field-sized, one loop long, and loops seamlessly", async () => {
    const dir = tmpDir();
    const out = join(dir, "backdrop.mp4");
    const motion = await renderBackdropVideo(moving(), 640, 360, 30, 1, out);
    expect(motion).toEqual({ grain: 0, seed: 7, cell: 1 });
    const info = probe(out);
    expect([info.width, info.height]).toEqual([640, 360]);
    const frames = await decode(out, 640, 360);
    expect(frames).toHaveLength(30);
    const steps = frames.map((f, i) => mad(f, frames[(i + 1) % 30] as Uint8ClampedArray));
    expect(steps[29] as number).toBeLessThanOrEqual(Math.max(...steps.slice(0, 29)) * 1.1 + 0.3);
    expect(mad(frames[0] as Uint8ClampedArray, frames[15] as Uint8ClampedArray)).toBeGreaterThan(2);
  }, 60_000);

  test("a huge scene still gets a ≤1280-px intermediate, and a 1-frame master a 1-frame loop", async () => {
    const dir = tmpDir();
    const big = join(dir, "big.mp4");
    const motion = await renderBackdropVideo(moving({ grain: 0.05 }), 9368, 5272, 30, 0.1, big);
    expect(probe(big).width).toBe(1280);
    expect(motion.cell).toBe(5);
    const one = join(dir, "one.mp4");
    await renderBackdropVideo(moving(), 640, 360, 30, 0.02, one);
    expect(await decode(one, 640, 360)).toHaveLength(1);
  }, 60_000);

  test("motionFilter: scale, then grain (cells are scaled up with nearest-neighbour)", () => {
    expect(motionFilter(1920, 1080, { grain: 0, seed: 1, cell: 1 })).toBe("scale=1920:1080:flags=bicubic");
    expect(motionFilter(1920, 1080, { grain: 0.05, seed: 3, cell: 1 })).toBe(
      "scale=1920:1080:flags=bicubic,format=yuv444p,noise=c0s=11:c0f=t+u:all_seed=3",
    );
    expect(motionFilter(4688, 2636, { grain: 0.3, seed: -1, cell: 2 })).toBe(
      "scale=2344:1318:flags=bicubic,format=yuv444p,noise=c0s=66:c0f=t+u:all_seed=2147483647," +
        "scale=4688:2636:flags=neighbor",
    );
  });
});
