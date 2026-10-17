import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, ImageData, type SKRSContext2D } from "@napi-rs/canvas";
import { CameraworkError } from "./errors.js";
import { FrameSink, readFrames, requireFfmpeg } from "./ffmpeg.js";
import { sceneLayout } from "./geometry.js";
import { cameraAt } from "./plan/interp.js";
import { makeLookAssets } from "./render/assets.js";
import { encoderArgs } from "./render/encode.js";
import { checkMaster } from "./render/index.js";
import { sceneArgs } from "./render/scene.js";
import type { Plan, Shot } from "./schema.js";

export interface PreviewOptions {
  out: string;
  every?: number;
  columns?: number;
  tileWidth?: number;
  debugWidth?: number;
}

const even = (n: number) => Math.round(n / 2) * 2;

/** Scales the scene graph's output to the debug size (works for both the -vf and the -filter_complex form). */
function scaled(args: string[], w: number, h: number): string[] {
  return args.map((a, i) => {
    if (args[i - 1] === "-vf") return `${a},scale=${w}:${h}`;
    if (args[i - 1] === "-filter_complex") return a.replace("format=rgba[out]", `format=rgba,scale=${w}:${h}[out]`);
    return a;
  });
}

/** Draws numbered shot boxes (red for auto, cyan for cue) with `k` mapping scene pixels to the canvas. */
function drawShots(ctx: SKRSContext2D, shots: [number, Shot][], k: number, font: number): void {
  for (const [n, s] of shots) {
    ctx.strokeStyle = s.source === "cue" ? "#33ddff" : "#ff4466";
    ctx.lineWidth = 2;
    ctx.strokeRect(s.rect[0] * k, s.rect[1] * k, s.rect[2] * k, s.rect[3] * k);
    ctx.fillStyle = "#ffffff";
    ctx.font = `${font}px sans-serif`;
    ctx.fillText(`#${n + 1}`, s.rect[0] * k, Math.max(font, s.rect[1] * k - 4));
  }
}

/** A contact sheet and a debug video showing the camera's frame (yellow), auto shots (red) and cues (cyan). */
export async function preview(plan: Plan, opts: PreviewOptions): Promise<{ sheet: string; debug: string }> {
  requireFfmpeg();
  checkMaster(plan);
  const every = opts.every ?? 0.5;
  const columns = opts.columns ?? 6;
  const tileW = opts.tileWidth ?? 480;
  const debugW = opts.debugWidth ?? 960;
  const layout = sceneLayout(plan.master, plan.look, plan.output.aspect);
  const work = mkdtempSync(join(tmpdir(), "camerawork-preview-"));
  try {
    const assets = await makeLookAssets(layout, plan.look, work);
    const fps = plan.output.fps;
    const k = debugW / layout.sceneW;
    const dH = even(layout.sceneH * k);
    const tileH = Math.round((tileW / debugW) * dH);
    const tiles = Math.max(1, Math.ceil(plan.master.duration / every));
    const sheetCanvas = createCanvas(columns * tileW, Math.ceil(tiles / columns) * tileH);
    const sctx = sheetCanvas.getContext("2d");
    const frameCanvas = createCanvas(debugW, dH);
    const fctx = frameCanvas.getContext("2d");
    const debugFinal = `${opts.out}-debug.mp4`;
    const debugPath = `${opts.out}-debug.tmp-${process.pid}.mp4`;
    const sheetFinal = `${opts.out}-sheet.png`;
    const sheetPath = `${opts.out}-sheet.tmp-${process.pid}.png`;
    const sink = new FrameSink(encoderArgs("mp4", debugW, dH, fps, debugPath));
    let nextTile = 0;
    try {
      await readFrames(
        scaled(sceneArgs(plan.master.path, layout, assets, fps), debugW, dH),
        debugW * dH * 4,
        async (frame, i) => {
          const t = i / fps;
          fctx.putImageData(
            new ImageData(new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.length), debugW, dH),
            0,
            0,
          );
          const v = cameraAt(plan.keyframes, t);
          const vw = (layout.sceneW / v.zoom) * k;
          const vh = (layout.sceneH / v.zoom) * k;
          fctx.lineWidth = 3;
          fctx.strokeStyle = "#ffcc00";
          fctx.strokeRect(v.cx * k - vw / 2, v.cy * k - vh / 2, vw, vh);
          drawShots(
            fctx,
            [...plan.shots.entries()].filter(([, s]) => t >= s.start - 0.05 && t <= s.end + 0.05),
            k,
            18,
          );
          fctx.fillStyle = "rgba(0,0,0,0.6)";
          fctx.fillRect(0, 0, 96, 30);
          fctx.fillStyle = "#ffffff";
          fctx.font = "20px sans-serif";
          fctx.fillText(`${t.toFixed(1)} s`, 8, 22);
          if (t + 1e-6 >= nextTile * every && nextTile < tiles) {
            sctx.drawImage(
              frameCanvas,
              (nextTile % columns) * tileW,
              Math.floor(nextTile / columns) * tileH,
              tileW,
              tileH,
            );
            // Auto shots are shorter than a tile: draw every shot that overlaps this tile's time span.
            sctx.save();
            sctx.translate((nextTile % columns) * tileW, Math.floor(nextTile / columns) * tileH);
            sctx.beginPath();
            sctx.rect(0, 0, tileW, tileH);
            sctx.clip();
            const t0 = nextTile * every;
            drawShots(
              sctx,
              [...plan.shots.entries()].filter(([, s]) => s.start < t0 + every && s.end >= t0),
              (k * tileW) / debugW,
              12,
            );
            sctx.restore();
            nextTile++;
          }
          await sink.write(Buffer.from(frameCanvas.data())); // copied: the canvas is redrawn next frame
        },
      );
      await sink.end();
      try {
        writeFileSync(sheetPath, sheetCanvas.toBuffer("image/png"));
      } catch (error) {
        throw new CameraworkError(
          `cannot write the contact sheet ${sheetFinal}: ${(error as Error).message}. Check that the output directory exists and is writable.`,
        );
      }
      renameSync(debugPath, debugFinal);
      renameSync(sheetPath, sheetFinal);
    } catch (error) {
      await sink.kill();
      rmSync(debugPath, { recursive: true, force: true });
      rmSync(sheetPath, { recursive: true, force: true });
      throw error;
    }
    return { sheet: sheetFinal, debug: debugFinal };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
