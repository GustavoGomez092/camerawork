import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { CameraworkError } from "./errors.js";
import { probe, readFrames, requireFfmpeg } from "./ffmpeg.js";
import { sceneLayout } from "./geometry.js";
import { PLACEHOLDER, placeholderWindow } from "./placeholder.js";
import { makeLookAssets } from "./render/assets.js";
import { sceneArgs } from "./render/scene.js";
import type { Look } from "./schema.js";

export interface LookPreviewOptions {
  /** The PNG to write. */
  out: string;
  /** A master video: the window shows its frame at `at`. Without it, a neutral placeholder window. */
  master?: string;
  /** Seconds into the master (default: the middle). */
  at?: number;
  /** Output width in pixels (default: the scene's width). */
  width?: number;
}

/**
 * One composed still of a look (spec: backdrops §5): the backdrop (an animated one at loop time 0), shadow and the
 * window, through the same scene graph as render. Returns the PNG's path.
 */
export async function lookPreview(look: Look, opts: LookPreviewOptions): Promise<string> {
  requireFfmpeg();
  if (opts.width !== undefined && (!Number.isInteger(opts.width) || opts.width < 16))
    throw new CameraworkError(`--width must be a whole number of pixels, at least 16 (got ${opts.width})`);
  const work = mkdtempSync(join(tmpdir(), "camerawork-look-"));
  const tmp = `${opts.out}.tmp-${process.pid}.png`;
  try {
    let source: string;
    let size: { width: number; height: number };
    const seek: string[] = [];
    if (opts.master) {
      const info = probe(opts.master);
      const asked = opts.at ?? info.duration / 2;
      if (!(asked >= 0 && asked < info.duration))
        throw new CameraworkError(`--at ${asked} is outside the master (0 to ${info.duration.toFixed(2)} s)`);
      // The last frame, not after it: a seek past the final frame yields nothing and the looping inputs never end.
      const at = Math.min(asked, Math.max(0, info.duration - 1.5 / info.fps));
      source = opts.master;
      size = info;
      seek.push("-ss", at.toFixed(3));
    } else {
      source = join(work, "window.png");
      writeFileSync(source, placeholderWindow());
      size = PLACEHOLDER;
    }
    const layout = sceneLayout(size, look, size.width / size.height);
    const assets = await makeLookAssets(layout, look, work);
    let scene: Buffer | null = null;
    await readFrames(
      [...seek, ...sceneArgs(source, layout, assets, 30), "-frames:v", "1"],
      layout.sceneW * layout.sceneH * 4,
      (f) => {
        scene = Buffer.from(f);
      },
      120_000,
    );
    if (!scene) throw new CameraworkError(`no frame of ${source} at the requested time`);
    const pixels = scene as Buffer;
    const full = createCanvas(layout.sceneW, layout.sceneH);
    full
      .getContext("2d")
      .putImageData(
        new ImageData(
          new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length),
          layout.sceneW,
          layout.sceneH,
        ),
        0,
        0,
      );
    const w = opts.width ?? layout.sceneW;
    const h = Math.max(1, Math.round((layout.sceneH * w) / layout.sceneW));
    const outCanvas = w === layout.sceneW ? full : createCanvas(w, h);
    if (outCanvas !== full) {
      const ctx = outCanvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(full, 0, 0, w, h);
    }
    try {
      writeFileSync(tmp, outCanvas.toBuffer("image/png"));
    } catch (error) {
      throw new CameraworkError(`cannot write ${opts.out}: ${(error as Error).message}`);
    }
    renameSync(tmp, opts.out);
    return opts.out;
  } finally {
    rmSync(tmp, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}
