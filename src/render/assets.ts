import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Canvas, createCanvas, loadImage } from "@napi-rs/canvas";
import { gradientLine } from "../backdrops/gradient.js";
import { CameraworkError } from "../errors.js";
import { runFfmpeg } from "../ffmpeg.js";
import { lookScale, type SceneLayout, WARP_BORDER } from "../geometry.js";
import type { Backdrop, Look } from "../schema.js";
import { type BackdropMotion, renderBackdropVideo, shaderCanvas } from "./backdrop.js";
import { perspectiveExpr } from "./scene.js";

export interface LookAssets {
  /** A PNG looped as a still, or (when `motion` is set) the animated backdrop's intermediate video, looped. */
  backdrop: string;
  motion: BackdropMotion | null;
  mask: string | null;
  shadow: string | null;
  shadowX: number;
  shadowY: number;
}

/** For an animated backdrop: the output fps and the master's duration (one loop). Leave it out for a still. */
export interface LookTiming {
  fps: number;
  duration: number;
}

const png = (path: string, canvas: Canvas) => writeFileSync(path, canvas.toBuffer("image/png"));

/** Any backdrop as a w×h canvas; a shader backdrop is drawn at loop time 0. */
export async function backdropCanvas(bd: Backdrop, w: number, h: number): Promise<Canvas> {
  if (bd.type === "shader") return shaderCanvas(bd, w, h);
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  if (bd.type === "gradient") {
    const g = ctx.createLinearGradient(...gradientLine(w, h, bd.angle));
    for (const s of bd.stops) g.addColorStop(s.at, s.color);
    ctx.fillStyle = g;
  } else if (bd.type === "solid") {
    ctx.fillStyle = bd.color;
  } else {
    ctx.fillStyle = "#000000";
  }
  ctx.fillRect(0, 0, w, h);
  if (bd.type === "image") {
    let img: Awaited<ReturnType<typeof loadImage>>;
    try {
      img = await loadImage(bd.path);
    } catch {
      throw new CameraworkError(`cannot read the backdrop image ${bd.path}`);
    }
    const s = Math.max(w / img.width, h / img.height); // cover
    ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
  }
  return c;
}

/**
 * Draws the backdrop, the (warped) rounded mask and the shadow once, before rendering (ruling R7). With `timing`, a
 * shader backdrop with motion becomes an intermediate video of one loop; otherwise the backdrop is a PNG. Nothing is
 * drawn for the backdrop when the window covers the whole scene.
 */
export async function makeLookAssets(
  layout: SceneLayout,
  look: Look,
  workDir: string,
  timing?: LookTiming,
): Promise<LookAssets> {
  const k = lookScale(layout.winW);
  const radius = look.radius * k;
  const warp = perspectiveExpr(layout);
  const windowIsScene = layout.sceneW === layout.winW && layout.sceneH === layout.winH;
  // The mask also hides the WARP_BORDER around the window, so it is skipped only when the window is the scene.
  const hidden = radius === 0 && !warp && look.shadow.opacity === 0 && windowIsScene;
  const bd = look.backdrop;
  let backdrop = join(workDir, "backdrop.png");
  let motion: BackdropMotion | null = null;
  if (hidden) return { backdrop, motion, mask: null, shadow: null, shadowX: 0, shadowY: 0 };
  if (bd.type === "shader" && bd.motion.enabled && timing) {
    backdrop = join(workDir, "backdrop.mp4");
    motion = await renderBackdropVideo(bd, layout.sceneW, layout.sceneH, timing.fps, timing.duration, backdrop);
  } else {
    png(backdrop, await backdropCanvas(bd, layout.sceneW, layout.sceneH));
  }

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

  if (look.shadow.opacity === 0) return { backdrop, motion, mask, shadow: null, shadowX: 0, shadowY: 0 };
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
    motion,
    mask,
    shadow,
    shadowX: layout.winX - B - S,
    shadowY: Math.round(layout.winY - B - S + look.shadow.offsetY * k),
  };
}
