import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../src/ffmpeg.js";

/** A fresh temp directory. Its name contains a space on purpose (Review Focus 5). */
export function tmpDir(prefix = "camerawork test "): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Box {
  x: number;
  y: number;
  size: number;
  /** Width and height, when the box is not square (default `size`). */
  w?: number;
  h?: number;
  from: number;
  to: number;
  color?: string;
}

/** A synthetic recording: a dark gray frame with solid boxes that appear and disappear at known times. */
export async function makeBoxVideo(
  path: string,
  opts: { width: number; height: number; fps: number; seconds: number; boxes: Box[] },
): Promise<void> {
  const draws = opts.boxes.map(
    (b) =>
      `drawbox=x=${b.x}:y=${b.y}:w=${b.w ?? b.size}:h=${b.h ?? b.size}:color=${b.color ?? "red"}:t=fill:enable='between(t,${b.from},${b.to})'`,
  );
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=0x202020:size=${opts.width}x${opts.height}:rate=${opts.fps}:duration=${opts.seconds}`,
    "-vf",
    draws.length ? draws.join(",") : "null",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "12",
    path,
  ]);
}
