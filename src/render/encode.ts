import { hasEncoder } from "../ffmpeg.js";

export const pickWebmCodec = (): "av1" | "vp9" => (hasEncoder("libsvtav1") ? "av1" : "vp9");

/**
 * The quality steps a render takes, best first, when an output must fit `maxBytes`: the first is the normal encode,
 * the rest re-encode that file a step lower (x264 / AV1 / VP9 CRF). Text stays legible down to the last step.
 */
export const CRF_STEPS = { mp4: [20, 24, 28, 32], webm: [32, 38, 44, 50] } as const;

/** ffmpeg args that re-encode a finished output at a lower quality, to fit a byte budget. */
export function reencodeArgs(
  format: "mp4" | "webm",
  input: string,
  crf: number,
  out: string,
  codec: "av1" | "vp9" = "av1",
): string[] {
  const head = ["-i", input, "-an"];
  if (format === "mp4")
    return [
      ...head,
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      out,
    ];
  if (codec === "av1")
    return [
      ...head,
      "-c:v",
      "libsvtav1",
      "-crf",
      String(crf),
      "-preset",
      "6",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "webm",
      out,
    ];
  return [
    ...head,
    "-c:v",
    "libvpx-vp9",
    "-crf",
    String(crf),
    "-b:v",
    "0",
    "-row-mt",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "webm",
    out,
  ];
}

/** ffmpeg args that read raw RGBA frames on stdin and encode one web format (spec §6.2). */
export function encoderArgs(
  format: "mp4" | "webm",
  width: number,
  height: number,
  fps: number,
  out: string,
  codec: "av1" | "vp9" = "av1",
): string[] {
  const input = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "-"];
  if (format === "mp4")
    return [
      ...input,
      ...["-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
      ...["-f", "mp4", out],
    ];
  if (codec === "av1")
    return [...input, "-c:v", "libsvtav1", "-crf", "32", "-preset", "6", "-pix_fmt", "yuv420p", "-f", "webm", out];
  return [
    ...input,
    ...["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-pix_fmt", "yuv420p", "-f", "webm", out],
  ];
}
