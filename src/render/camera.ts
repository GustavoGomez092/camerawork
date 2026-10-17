import { type Canvas, createCanvas, ImageData, type SKRSContext2D } from "@napi-rs/canvas";
import type { View } from "../schema.js";

/**
 * Applies a camera view to scene frames with Skia: sub-pixel transform, mipmapped bilinear ("medium") or cubic
 * ("high") resampling (ruling R4). Output is opaque, so Skia's premultiplied pixels equal straight RGBA.
 */
export class Camera {
  private readonly src: Canvas;
  private readonly sctx: SKRSContext2D;
  private readonly out: Canvas;
  private readonly octx: SKRSContext2D;

  constructor(
    private readonly sceneW: number,
    private readonly sceneH: number,
    private readonly outW: number,
    private readonly outH: number,
    quality: "medium" | "high",
  ) {
    this.src = createCanvas(sceneW, sceneH);
    this.sctx = this.src.getContext("2d");
    this.out = createCanvas(outW, outH);
    this.octx = this.out.getContext("2d");
    this.octx.imageSmoothingEnabled = true;
    this.octx.imageSmoothingQuality = quality;
  }

  frame(scene: Buffer, view: View): Buffer {
    const pixels = new Uint8ClampedArray(scene.buffer, scene.byteOffset, scene.length);
    this.sctx.putImageData(new ImageData(pixels, this.sceneW, this.sceneH), 0, 0);
    const s = (this.outW / this.sceneW) * view.zoom;
    const vw = this.sceneW / view.zoom;
    const vh = this.sceneH / view.zoom;
    const cx = Math.min(this.sceneW - vw / 2, Math.max(vw / 2, view.cx));
    const cy = Math.min(this.sceneH - vh / 2, Math.max(vh / 2, view.cy));
    this.octx.setTransform(1, 0, 0, 1, 0, 0);
    this.octx.fillStyle = "#000000";
    this.octx.fillRect(0, 0, this.outW, this.outH);
    this.octx.setTransform(s, 0, 0, s, this.outW / 2 - cx * s, this.outH / 2 - cy * s);
    this.octx.drawImage(this.src, 0, 0);
    // A copy: stream writes keep a reference until flushed, and the canvas memory is reused for the next frame.
    return Buffer.from(this.out.data());
  }

  /** The current output frame as an encoded poster image. */
  encode(format: "jpg" | "webp"): Buffer {
    return format === "jpg" ? this.out.toBuffer("image/jpeg", 90) : this.out.toBuffer("image/webp", 90);
  }
}
