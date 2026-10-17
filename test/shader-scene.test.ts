import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFrames } from "../src/ffmpeg.js";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS, resolveLook } from "../src/looks.js";
import { plan, readPlan, writeJsonAtomic } from "../src/plan/index.js";
import { preview } from "../src/preview.js";
import { type LookAssets, makeLookAssets } from "../src/render/assets.js";
import { render } from "../src/render/index.js";
import { sceneArgs } from "../src/render/scene.js";
import type { Look } from "../src/schema.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

const layout = sceneLayout({ width: 640, height: 360 }, LOOKS.hero, 16 / 9);
const base: LookAssets = { backdrop: "/w/bd", motion: null, mask: "/w/mask.png", shadow: null, shadowX: 0, shadowY: 0 };

/** The hero window on a left-to-right red → blue linear backdrop with no noise, grain or vignette. */
const redBlue = (motion = false): Look =>
  resolveLook({
    ...LOOKS.hero,
    backdrop: {
      type: "shader",
      style: "linear",
      colors: ["#ff0000", "#0000ff"],
      angle: 90,
      distortion: motion ? 0.6 : 0,
      grain: 0,
      motion: { enabled: motion, speed: 2 },
    },
  } as Look);

/** RGB of pixel (x, y) in frame `index` of a video, w×h. */
async function pixelAt(video: string, index: number, w: number, h: number, x: number, y: number) {
  let rgb: number[] = [];
  await readFrames(["-i", video, "-pix_fmt", "rgb24"], w * h * 3, (f, i) => {
    if (i === index) rgb = [...f.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
  });
  return rgb;
}

describe("scene graph input selection", () => {
  test("a still backdrop is a looped image", () => {
    const args = sceneArgs("/m.mp4", layout, base, 30);
    expect(args.slice(2, 8)).toEqual(["-loop", "1", "-framerate", "30", "-i", "/w/bd"]);
    expect(args.join(" ")).toContain("[1:v]format=rgba[bg]");
    expect(args).not.toContain("-stream_loop");
  });

  test("an animated backdrop is its intermediate video, looped, upscaled and grained", () => {
    const args = sceneArgs("/m.mp4", layout, { ...base, motion: { grain: 0.05, seed: 7, cell: 1 } }, 30);
    expect(args.slice(2, 6)).toEqual(["-stream_loop", "-1", "-i", "/w/bd"]);
    const graph = args[args.indexOf("-filter_complex") + 1] as string;
    expect(graph).toContain(
      `[1:v]fps=30,scale=${layout.sceneW}:${layout.sceneH}:flags=bicubic,format=yuv444p,noise=c0s=11:c0f=t+u:all_seed=7,format=rgba[bg]`,
    );
  });
});

describe("look assets for shader backdrops", () => {
  test("still → backdrop.png; motion with timing → backdrop.mp4; motion without timing → a still", async () => {
    const dir = tmpDir();
    const still = await makeLookAssets(layout, redBlue(false), dir, { fps: 30, duration: 1 });
    expect([still.backdrop, still.motion]).toEqual([join(dir, "backdrop.png"), null]);
    const moving = await makeLookAssets(layout, redBlue(true), dir, { fps: 30, duration: 1 });
    expect(moving.backdrop).toBe(join(dir, "backdrop.mp4"));
    expect(moving.motion).toEqual({ grain: 0, seed: 1, cell: 1 });
    expect(existsSync(moving.backdrop)).toBe(true);
    expect((await makeLookAssets(layout, redBlue(true), tmpDir())).motion).toBeNull();
  }, 60_000);

  test("no backdrop work when the window covers the scene", async () => {
    const look = { ...redBlue(true), padding: 0, radius: 0, shadow: { blur: 0, offsetY: 0, opacity: 0 } };
    const flatLayout = sceneLayout({ width: 640, height: 360 }, look, 16 / 9);
    const dir = tmpDir();
    const assets = await makeLookAssets(flatLayout, look, dir, { fps: 30, duration: 1 });
    expect([assets.mask, assets.motion]).toEqual([null, null]);
    expect(existsSync(join(dir, "backdrop.mp4"))).toBe(false);
  });
});

describe("rendering with shader backdrops (spec: backdrops §8 integration)", () => {
  test("a still shader backdrop round-trips through plan.json and has the expected colours at the scene corners", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const p = await plan(master, { look: redBlue(false), output: { width: 640, formats: ["mp4"], poster: null } });
    writeJsonAtomic(join(dir, "plan.json"), p);
    const again = readPlan(join(dir, "plan.json"));
    expect(again.look.backdrop).toEqual(redBlue(false).backdrop);
    const [video] = await render(again, { out: join(dir, "out") });
    const left = await pixelAt(video as string, 0, 640, 360, 3, 180);
    const right = await pixelAt(video as string, 0, 640, 360, 636, 180);
    expect(left[0] as number).toBeGreaterThan(200);
    expect(left[2] as number).toBeLessThan(80);
    expect(right[2] as number).toBeGreaterThan(200);
    expect(right[0] as number).toBeLessThan(80);
  }, 60_000);

  test("a backdrop preset by name renders, and an animated one moves in the render and the debug video", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const named = await plan(master, { look: "ultraviolet", output: { width: 640, formats: ["mp4"], poster: null } });
    expect(named.look.preset).toBe("ultraviolet");
    const p = await plan(master, { look: redBlue(true), output: { width: 640, formats: ["mp4"], poster: null } });
    const [video] = await render(p, { out: join(dir, "out") });
    const a = await pixelAt(video as string, 0, 640, 360, 3, 3);
    const b = await pixelAt(video as string, 15, 640, 360, 3, 3);
    expect(
      Math.abs((a[0] as number) - (b[0] as number)) + Math.abs((a[2] as number) - (b[2] as number)),
    ).toBeGreaterThan(8);
    const { debug } = await preview(p, { out: join(dir, "plan") });
    const d0 = await pixelAt(debug, 0, 960, 540, 4, 4);
    const d15 = await pixelAt(debug, 15, 960, 540, 4, 4);
    expect(
      Math.abs((d0[0] as number) - (d15[0] as number)) + Math.abs((d0[2] as number) - (d15[2] as number)),
    ).toBeGreaterThan(8);
  }, 120_000);

  test("motion with a 2-frame master renders (Review Focus 3)", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 2 / 30, boxes: [] });
    const p = await plan(master, { look: redBlue(true), output: { width: 640, formats: ["mp4"], poster: null } });
    const files = await render(p, { out: join(dir, "out") });
    expect(existsSync(files[0] as string)).toBe(true);
  }, 60_000);
});
