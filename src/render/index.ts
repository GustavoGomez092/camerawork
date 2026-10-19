import { existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CameraworkError } from "../errors.js";
import { FrameSink, probe, readFrames, requireFfmpeg } from "../ffmpeg.js";
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
  const sharpMax = plan.scene.width / plan.output.width;
  if (plan.output.width * deepest > plan.scene.width + 1e-6)
    throw new CameraworkError(
      `zoom ${deepest.toFixed(2)} at ${plan.output.width} px would upscale the ${plan.scene.width}-px scene. ` +
        `Keep zoom at or below ${sharpMax.toFixed(2)}, lower the output width, or record a bigger master.`,
    );
  if (deepest > plan.maxZoom + 1e-6)
    throw new CameraworkError(
      `zoom ${deepest.toFixed(2)} exceeds the plan's maxZoom of ${plan.maxZoom}. ` +
        `Keep zoom at or below ${plan.maxZoom}: re-run plan or edit the keyframes.`,
    );
}

/** Refuses a missing or changed master (different size or duration) before anything starts. */
export function checkMaster(plan: Plan): void {
  const path = plan.master.path;
  if (!existsSync(path))
    throw new CameraworkError(
      `the master ${path} is missing. Restore it (or run camerawork plan again on the video you want to render).`,
    );
  const now = probe(path);
  const m = plan.master;
  const diffs: string[] = [];
  if (now.width !== m.width || now.height !== m.height)
    diffs.push(`size is ${now.width}x${now.height}, the plan was made for ${m.width}x${m.height}`);
  if (Math.abs(now.duration - m.duration) > 0.1)
    diffs.push(`duration is ${now.duration.toFixed(2)} s, the plan was made for ${m.duration.toFixed(2)} s`);
  if (diffs.length)
    throw new CameraworkError(
      `the master ${path} has changed since planning: ${diffs.join("; ")}. Re-run camerawork plan.`,
    );
}

/**
 * While a render or preview runs, Ctrl-C / SIGTERM removes its work folder and stops its ffmpeg sinks, then re-raises
 * the signal so the exit status stays 130 / 143. The handlers are `once` ones added next to the caller's own, which
 * keep working; call the returned function (in `finally`) to remove them.
 */
export function cleanupOnSignal(work: string, sinks: () => FrameSink[]): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const remove = () => {
    for (const [sig, fn] of handlers) process.off(sig, fn);
    handlers.clear();
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const fn = () => {
      for (const sink of sinks()) sink.killNow();
      rmSync(work, { recursive: true, force: true });
      remove();
      // Re-raise only when nobody else listens: then the default action (exit by the signal) applies. If the host app
      // has its own handler, it already ran for this signal and decides what happens next.
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    handlers.set(sig, fn);
    process.once(sig, fn);
  }
  return remove;
}

const even = (n: number) => Math.round(n / 2) * 2;

/** Renders a plan: scene (ffmpeg) → camera (Skia) → encoders, all streaming; files appear only on success. */
export async function render(plan: Plan, opts: RenderOptions): Promise<string[]> {
  requireFfmpeg();
  checkMaster(plan);
  checkSharpness(plan);
  const layout = sceneLayout(plan.master, plan.look, plan.output.aspect);
  if (layout.sceneW !== plan.scene.width || layout.sceneH !== plan.scene.height)
    throw new CameraworkError("the plan's scene size does not match its look and master; re-run plan");
  const outW = plan.output.width;
  const outH = even(outW / plan.output.aspect);
  const work = mkdtempSync(join(tmpdir(), "camerawork-"));
  const tmp = (ext: string) => `${opts.out}.tmp-${process.pid}.${ext}`;
  const written: [string, string][] = [];
  const sinks: FrameSink[] = [];
  const unguard = cleanupOnSignal(work, () => sinks);
  try {
    const assets = await makeLookAssets(layout, plan.look, work, {
      fps: plan.output.fps,
      duration: plan.master.duration,
    });
    const codec = pickWebmCodec();
    for (const format of plan.output.formats) {
      const path = tmp(format);
      written.push([path, `${opts.out}.${format}`]);
      sinks.push(new FrameSink(encoderArgs(format, outW, outH, plan.output.fps, path, codec)));
    }
    const camera = new Camera(layout.sceneW, layout.sceneH, outW, outH, plan.output.quality);
    const total = Math.round(plan.master.duration * plan.output.fps);
    const posterFrame = Math.min(Math.max(0, total - 1), Math.round(plan.output.posterAt * plan.output.fps));
    let posterWritten = false;
    await readFrames(
      sceneArgs(plan.master.path, layout, assets, plan.output.fps),
      layout.sceneW * layout.sceneH * 4,
      async (scene, i) => {
        const frame = camera.frame(scene, cameraAt(plan.keyframes, i / plan.output.fps));
        if (!posterWritten && i >= posterFrame && plan.output.poster) {
          posterWritten = true;
          const path = tmp(plan.output.poster);
          written.push([path, `${opts.out}.${plan.output.poster}`]);
          try {
            writeFileSync(path, camera.encode(plan.output.poster));
          } catch (error) {
            throw new CameraworkError(
              `cannot write the poster ${opts.out}.${plan.output.poster}: ${(error as Error).message}. Check that the output directory exists and is writable.`,
            );
          }
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
    await Promise.all(sinks.map((s) => s.kill()));
    for (const [path] of written) rmSync(path, { recursive: true, force: true });
    throw error;
  } finally {
    unguard();
    rmSync(work, { recursive: true, force: true });
  }
}
