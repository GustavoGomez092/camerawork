import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadImage } from "@napi-rs/canvas";
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
});
