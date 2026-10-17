import { fieldSize } from "../src/backdrops/field.js";
import { gradientLine } from "../src/backdrops/gradient.js";
import { shaderField } from "../src/backdrops/index.js";
import { applyGrain } from "../src/backdrops/post.js";
import type { Backdrop } from "../src/schema.js";

const scratch = document.createElement("canvas");

export interface PaintOptions {
  /** Loop time 0–1 (0 when not playing). */
  t: number;
  /** Frame number, for the grain's seed while playing. */
  frame: number;
  /** The field's long side: small while dragging, up to 1280 when settled (spec: backdrops §6). */
  maxField: number;
}

/**
 * Paints a backdrop into a canvas the way the render does: a shader is computed at a reduced field size, upscaled
 * with high-quality smoothing, then grained at the canvas's size. Gradients use the render's gradient line.
 */
export function paintBackdrop(canvas: HTMLCanvasElement, bd: Backdrop, opts: PaintOptions): void {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const { width: w, height: h } = canvas;
  if (bd.type === "shader") {
    const [fw, fh] = fieldSize(w, h, opts.maxField);
    scratch.width = fw;
    scratch.height = fh;
    const px = shaderField(bd, fw, fh, opts.t) as Uint8ClampedArray<ArrayBuffer>;
    (scratch.getContext("2d") as CanvasRenderingContext2D).putImageData(new ImageData(px, fw, fh), 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(scratch, 0, 0, w, h);
    if (bd.grain > 0) {
      const img = ctx.getImageData(0, 0, w, h);
      applyGrain(img.data, w, h, { grain: bd.grain, seed: bd.seed, frame: opts.frame, cell: 1 });
      ctx.putImageData(img, 0, 0);
    }
    return;
  }
  if (bd.type === "gradient") {
    const g = ctx.createLinearGradient(...gradientLine(w, h, bd.angle));
    for (const s of bd.stops) g.addColorStop(s.at, s.color);
    ctx.fillStyle = g;
  } else if (bd.type === "solid") {
    ctx.fillStyle = bd.color;
  } else {
    ctx.fillStyle = bd.type === "image" ? "#2a2a2e" : "#000000";
  }
  ctx.fillRect(0, 0, w, h);
  if (bd.type === "image") {
    ctx.fillStyle = "#a1a1aa";
    ctx.font = `${Math.max(11, Math.round(h / 24))}px system-ui, sans-serif`;
    ctx.fillText("image backdrop (shown in the render)", 12, h - 12);
  }
}
