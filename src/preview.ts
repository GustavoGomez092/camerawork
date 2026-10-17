import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { FrameSink, readFrames, requireFfmpeg } from "./ffmpeg.js";
import { sceneLayout } from "./geometry.js";
import { cameraAt } from "./plan/interp.js";
import { makeLookAssets } from "./render/assets.js";
import { encoderArgs } from "./render/encode.js";
import { sceneArgs } from "./render/scene.js";
import type { Plan } from "./schema.js";

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

/** A contact sheet and a debug video showing the camera's frame (yellow), auto shots (red) and cues (cyan). */
export async function preview(plan: Plan, opts: PreviewOptions): Promise<{ sheet: string; debug: string }> {
  requireFfmpeg();
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
    const debugPath = `${opts.out}-debug.mp4`;
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
          for (const [n, s] of plan.shots.entries()) {
            if (t < s.start - 0.05 || t > s.end + 0.05) continue;
            fctx.strokeStyle = s.source === "cue" ? "#33ddff" : "#ff4466";
            fctx.lineWidth = 2;
            fctx.strokeRect(s.rect[0] * k, s.rect[1] * k, s.rect[2] * k, s.rect[3] * k);
            fctx.fillStyle = "#ffffff";
            fctx.font = "18px sans-serif";
            fctx.fillText(`#${n + 1}`, s.rect[0] * k, Math.max(18, s.rect[1] * k - 4));
          }
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
            nextTile++;
          }
          await sink.write(Buffer.from(frameCanvas.data())); // copied: the canvas is redrawn next frame
        },
      );
    } catch (error) {
      await sink.kill();
      throw error;
    }
    await sink.end();
    const sheetPath = `${opts.out}-sheet.png`;
    writeFileSync(sheetPath, sheetCanvas.toBuffer("image/png"));
    return { sheet: sheetPath, debug: debugPath };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
