import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CameraworkError } from "../errors.js";
import { FrameSink, readFrames, requireFfmpeg } from "../ffmpeg.js";
import { sceneLayout } from "../geometry.js";
import { cameraAt } from "../plan/interp.js";
import type { Plan } from "../schema.js";
import { makeLookAssets } from "./assets.js";
import { Camera } from "./camera.js";
import { encoderArgs, pickWebmCodec } from "./encode.js";
import { sceneArgs } from "./scene.js";

export interface RenderOptions {
  /** Output prefix: files are written as `<out>.mp4`, `<out>.webm`, `<out>.jpg|webp`. */
  out: string;
  onProgress?: (done: number, total: number) => void;
}

/** Refuses any plan that would upscale (spec §6.3, ruling R5). */
export function checkSharpness(plan: Plan): void {
  const deepest = Math.max(1, ...plan.keyframes.map((k) => k.zoom));
  if (plan.output.width * deepest > plan.scene.width + 1e-6 || deepest > plan.maxZoom + 1e-6)
    throw new CameraworkError(
      `zoom ${deepest.toFixed(2)} at ${plan.output.width} px would upscale the ${plan.scene.width}-px scene. ` +
        `Keep zoom at or below ${(plan.scene.width / plan.output.width).toFixed(2)}, lower the output width, ` +
        "or record a bigger master.",
    );
}

const even = (n: number) => Math.round(n / 2) * 2;

/** Renders a plan: scene (ffmpeg) → camera (Skia) → encoders, all streaming; files appear only on success. */
export async function render(plan: Plan, opts: RenderOptions): Promise<string[]> {
  requireFfmpeg();
  checkSharpness(plan);
  const layout = sceneLayout(plan.master, plan.look, plan.output.aspect);
  if (layout.sceneW !== plan.scene.width || layout.sceneH !== plan.scene.height)
    throw new CameraworkError("the plan's scene size does not match its look and master; re-run plan");
  const outW = plan.output.width;
  const outH = even(outW / plan.output.aspect);
  const work = mkdtempSync(join(tmpdir(), "camerawork-"));
  const tmp = (ext: string) => `${opts.out}.tmp-${process.pid}.${ext}`;
  const written: [string, string][] = [];
  try {
    const assets = await makeLookAssets(layout, plan.look, work);
    const codec = pickWebmCodec();
    const sinks = plan.output.formats.map((format) => {
      const path = tmp(format);
      written.push([path, `${opts.out}.${format}`]);
      return new FrameSink(encoderArgs(format, outW, outH, plan.output.fps, path, codec));
    });
    const camera = new Camera(layout.sceneW, layout.sceneH, outW, outH, plan.output.quality);
    const total = Math.round(plan.master.duration * plan.output.fps);
    await readFrames(
      sceneArgs(plan.master.path, layout, assets, plan.output.fps),
      layout.sceneW * layout.sceneH * 4,
      async (scene, i) => {
        const frame = camera.frame(scene, cameraAt(plan.keyframes, i / plan.output.fps));
        if (i === 0 && plan.output.poster) {
          const path = tmp(plan.output.poster);
          writeFileSync(path, camera.encode(plan.output.poster));
          written.push([path, `${opts.out}.${plan.output.poster}`]);
        }
        await Promise.all(sinks.map((s) => s.write(frame)));
        opts.onProgress?.(i + 1, total);
      },
    );
    await Promise.all(sinks.map((s) => s.end()));
    if (plan.output.maxBytes !== null)
      for (const [path, final] of written) {
        const size = statSync(path).size;
        if (size > plan.output.maxBytes)
          throw new CameraworkError(
            `${final} is ${size} bytes, larger than the ${plan.output.maxBytes}-byte limit. ` +
              "Lower the width or fps, or raise maxBytes.",
          );
      }
    for (const [path, final] of written) renameSync(path, final);
    return written.map(([, final]) => final);
  } catch (error) {
    for (const [path] of written) rmSync(path, { force: true });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
