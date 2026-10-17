import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Canvas, createCanvas, loadImage } from "@napi-rs/canvas";
import { CameraworkError } from "../errors.js";
import { runFfmpeg } from "../ffmpeg.js";
import { lookScale, type SceneLayout, WARP_BORDER } from "../geometry.js";
import type { Look } from "../schema.js";
import { perspectiveExpr } from "./scene.js";

export interface LookAssets {
  backdrop: string;
  mask: string | null;
  shadow: string | null;
  shadowX: number;
  shadowY: number;
}

const png = (path: string, canvas: Canvas) => writeFileSync(path, canvas.toBuffer("image/png"));

async function drawBackdrop(layout: SceneLayout, look: Look, path: string): Promise<void> {
  const c = createCanvas(layout.sceneW, layout.sceneH);
  const ctx = c.getContext("2d");
  const bd = look.backdrop;
  if (bd.type === "gradient") {
    const a = ((bd.angle - 90) * Math.PI) / 180; // CSS angles: 180 = top → bottom
    const half = (Math.abs(layout.sceneW * Math.cos(a)) + Math.abs(layout.sceneH * Math.sin(a))) / 2;
    const cx = layout.sceneW / 2;
    const cy = layout.sceneH / 2;
    const g = ctx.createLinearGradient(
      cx - Math.cos(a) * half,
      cy - Math.sin(a) * half,
      cx + Math.cos(a) * half,
      cy + Math.sin(a) * half,
    );
    for (const s of bd.stops) g.addColorStop(s.at, s.color);
    ctx.fillStyle = g;
  } else if (bd.type === "solid") {
    ctx.fillStyle = bd.color;
  } else {
    ctx.fillStyle = "#000000";
  }
  ctx.fillRect(0, 0, layout.sceneW, layout.sceneH);
  if (bd.type === "image") {
    let img: Awaited<ReturnType<typeof loadImage>>;
    try {
      img = await loadImage(bd.path);
    } catch {
      throw new CameraworkError(`cannot read the backdrop image ${bd.path}`);
    }
    const s = Math.max(layout.sceneW / img.width, layout.sceneH / img.height); // cover
    ctx.drawImage(
      img,
      (layout.sceneW - img.width * s) / 2,
      (layout.sceneH - img.height * s) / 2,
      img.width * s,
      img.height * s,
    );
  }
  png(path, c);
}

/** Draws the backdrop, the (warped) rounded mask and the shadow once, before rendering (ruling R7). */
export async function makeLookAssets(layout: SceneLayout, look: Look, workDir: string): Promise<LookAssets> {
  const backdrop = join(workDir, "backdrop.png");
  await drawBackdrop(layout, look, backdrop);
  const k = lookScale(layout.winW);
  const radius = look.radius * k;
  const warp = perspectiveExpr(layout);
  const windowIsScene = layout.sceneW === layout.winW && layout.sceneH === layout.winH;
  // The mask also hides the WARP_BORDER around the window, so it is skipped only when the window is the scene.
  if (radius === 0 && !warp && look.shadow.opacity === 0 && windowIsScene)
    return { backdrop, mask: null, shadow: null, shadowX: 0, shadowY: 0 };

  const B = WARP_BORDER;
  const flat = createCanvas(layout.winW + 2 * B, layout.winH + 2 * B);
  const fc = flat.getContext("2d");
  fc.fillStyle = "#000000";
  fc.fillRect(0, 0, flat.width, flat.height);
  fc.fillStyle = "#ffffff";
  fc.beginPath();
  fc.roundRect(B, B, layout.winW, layout.winH, radius);
  fc.fill();
  const flatMask = join(workDir, "mask-flat.png");
  png(flatMask, flat);
  const mask = join(workDir, "mask.png");
  await runFfmpeg(["-i", flatMask, "-vf", warp ? `format=gray,${warp}` : "format=gray", "-frames:v", "1", mask]);

  if (look.shadow.opacity === 0) return { backdrop, mask, shadow: null, shadowX: 0, shadowY: 0 };
  const blur = look.shadow.blur * k;
  const S = Math.ceil(blur * 2) + 2;
  const shadow = join(workDir, "shadow.png");
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=black:size=${layout.winW + 2 * B + 2 * S}x${layout.winH + 2 * B + 2 * S}`,
    "-i",
    mask,
    "-filter_complex",
    `[1:v]format=gray,pad=iw+${2 * S}:ih+${2 * S}:${S}:${S}:black,gblur=sigma=${Math.max(0.5, blur / 2)}[a];` +
      `[0:v]format=rgba[b];[b][a]alphamerge,colorchannelmixer=aa=${look.shadow.opacity}`,
    "-frames:v",
    "1",
    shadow,
  ]);
  return {
    backdrop,
    mask,
    shadow,
    shadowX: layout.winX - B - S,
    shadowY: Math.round(layout.winY - B - S + look.shadow.offsetY * k),
  };
}
