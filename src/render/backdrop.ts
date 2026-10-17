import { type Canvas, createCanvas, ImageData } from "@napi-rs/canvas";
import { fieldSize } from "../backdrops/field.js";
import { shaderField } from "../backdrops/index.js";
import { applyGrain, grainCell } from "../backdrops/post.js";
import { FrameSink } from "../ffmpeg.js";
import type { ShaderBackdrop } from "../schema.js";
import { renderFrames } from "./backdrop-frames.js";

/** How the scene graph shows an animated backdrop's intermediate video: upscaled, with grain re-seeded per frame. */
export interface BackdropMotion {
  grain: number;
  seed: number;
  /** Grain cell size in scene pixels (grainCell of the scene width). */
  cell: number;
}

/**
 * A still shader backdrop at w×h (spec: backdrops §4): computed at the reduced field size (≤ 1280 px on the long
 * side, vignette included), upscaled with Skia's high-quality resampling, then grain added at full size.
 */
export function shaderCanvas(bd: ShaderBackdrop, w: number, h: number, t = 0): Canvas {
  const [fw, fh] = fieldSize(w, h);
  const small = createCanvas(fw, fh);
  small.getContext("2d").putImageData(new ImageData(shaderField(bd, fw, fh, t), fw, fh), 0, 0);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small, 0, 0, w, h);
  if (bd.grain > 0) {
    const img = ctx.getImageData(0, 0, w, h);
    applyGrain(img.data, w, h, { grain: bd.grain, seed: bd.seed, frame: 0, cell: grainCell(w) });
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

/** Frames in one loop of an animated backdrop: the master's duration at the output fps, at least 1. */
export const motionFrameCount = (duration: number, fps: number): number => Math.max(1, Math.round(duration * fps));

/** ffmpeg args for the intermediate video: raw RGBA on stdin → H.264 RGB, CRF 12 (near-lossless, fast to write). */
export function intermediateArgs(w: number, h: number, fps: number, out: string): string[] {
  return [
    ...["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps), "-i", "-"],
    ...["-c:v", "libx264rgb", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "rgb24", "-f", "mp4", out],
  ];
}

/**
 * Renders one loop of an animated backdrop (frame i at t = i / frameCount, so the last frame leads straight back to
 * the first) at the field size into `out`. The scene graph upscales it and adds the grain (see motionFilter).
 */
export async function renderBackdropVideo(
  bd: ShaderBackdrop,
  sceneW: number,
  sceneH: number,
  fps: number,
  duration: number,
  out: string,
): Promise<BackdropMotion> {
  const [fw, fh] = fieldSize(sceneW, sceneH);
  const sink = new FrameSink(intermediateArgs(fw, fh, fps, out));
  try {
    await renderFrames(bd, fw, fh, motionFrameCount(duration, fps), (_, px) =>
      sink.write(Buffer.from(px.buffer, px.byteOffset, px.byteLength)),
    );
    await sink.end();
  } catch (error) {
    await sink.kill();
    throw error;
  }
  return { grain: bd.grain, seed: bd.seed, cell: grainCell(sceneW) };
}

/**
 * ffmpeg filters that turn the intermediate video into the scene's backdrop: a bicubic upscale, then monochrome
 * uniform grain (luma noise, re-seeded every frame) sized like applyGrain's. `noise` strength s moves RGB by about
 * ±0.58·s, so s = grain × 220 matches applyGrain's ±grain × 128.
 */
export function motionFilter(sceneW: number, sceneH: number, m: BackdropMotion): string {
  const full = `scale=${sceneW}:${sceneH}:flags=bicubic`;
  const strength = Math.min(100, Math.round(m.grain * 220));
  if (strength === 0) return full;
  const noise = `format=yuv444p,noise=c0s=${strength}:c0f=t+u:all_seed=${m.seed & 0x7fffffff}`;
  if (m.cell <= 1) return `${full},${noise}`;
  const gw = Math.ceil(sceneW / m.cell);
  const gh = Math.ceil(sceneH / m.cell);
  return `scale=${gw}:${gh}:flags=bicubic,${noise},scale=${sceneW}:${sceneH}:flags=neighbor`;
}
