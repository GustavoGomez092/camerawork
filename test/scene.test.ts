import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFrames } from "../src/ffmpeg.js";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS, resolveLook } from "../src/looks.js";
import { makeLookAssets } from "../src/render/assets.js";
import { perspectiveExpr, sceneArgs } from "../src/render/scene.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

const pixel = (f: Buffer, w: number, x: number, y: number) => [...f.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];

async function firstSceneFrame(lookName: "hero" | "flat", tilt = false, fps = 30) {
  const dir = tmpDir();
  const master = join(dir, "m.mp4");
  await makeBoxVideo(master, {
    width: 640,
    height: 360,
    fps: 30,
    seconds: 1,
    boxes: [{ x: 0, y: 0, size: 640, from: 0, to: 1, color: "0x2060ff" }],
  });
  const look = resolveLook(lookName);
  if (tilt) look.tilt = { rotateX: 4, rotateY: -8, perspective: 2400 };
  const layout = sceneLayout({ width: 640, height: 360 }, look, 16 / 9);
  const assets = await makeLookAssets(layout, look, dir);
  let frame = Buffer.alloc(0);
  let count = 0;
  await readFrames(sceneArgs(master, layout, assets, fps), layout.sceneW * layout.sceneH * 4, (f, i) => {
    if (i === 0) frame = Buffer.from(f);
    count++;
  });
  return { layout, frame, count };
}

describe("scene", () => {
  test("flat look: the scene is the master", async () => {
    const { layout, frame } = await firstSceneFrame("flat");
    expect([layout.sceneW, layout.sceneH]).toEqual([640, 360]);
    const [r, g, b] = pixel(frame, 640, 320, 180);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(80);
    expect(g).toBeLessThan(140);
  });

  test("hero look: window centered on the backdrop, opaque, with rounded corners", async () => {
    const { layout, frame } = await firstSceneFrame("hero");
    const w = layout.sceneW;
    const center = pixel(frame, w, Math.round(w / 2), Math.round(layout.sceneH / 2));
    expect(center[2]).toBeGreaterThan(200);
    expect(center[3]).toBe(255);
    const top = pixel(frame, w, Math.round(w / 2), 2);
    expect(Math.abs((top[0] as number) - 0x8f)).toBeLessThan(12);
    const corner = pixel(frame, w, layout.winX + 1, layout.winY + 1);
    expect(corner[2]).toBeLessThan(200);
  });

  test("tilt: the warp is applied and no black wedge appears beside the window", async () => {
    const { layout, frame } = await firstSceneFrame("hero", true);
    expect(perspectiveExpr(layout)).toContain("sense=destination");
    const beside = pixel(frame, layout.sceneW, layout.winX - 4, layout.winY + 20);
    expect(beside[0]).toBeGreaterThan(40);
  });

  test.each([
    [false, 30],
    [true, 30],
    [false, 15],
    [true, 15],
  ])("scene runs at the requested fps (tilt=%p, fps=%p)", async (tilt, fps) => {
    const { count } = await firstSceneFrame("hero", tilt, fps);
    expect(count).toBe(fps);
  });

  test("untilted layouts have no perspective expression", () => {
    expect(perspectiveExpr(sceneLayout({ width: 640, height: 360 }, LOOKS.flat, 16 / 9))).toBeNull();
  });
});
