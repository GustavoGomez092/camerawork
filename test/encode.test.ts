import { describe, expect, test } from "bun:test";
import { encoderArgs } from "../src/render/encode.js";

const raw = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1920x1080", "-r", "30", "-i", "-"];

describe("encoderArgs", () => {
  test("mp4 is H.264, slow, crf 20, yuv420p, faststart", () => {
    expect(encoderArgs("mp4", 1920, 1080, 30, "o.mp4")).toEqual([
      ...raw,
      ...["-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
      ...["-f", "mp4", "o.mp4"],
    ]);
  });

  test("webm is SVT-AV1 crf 32 preset 6, or VP9 crf 32", () => {
    expect(encoderArgs("webm", 1920, 1080, 30, "o.webm", "av1")).toEqual([
      ...raw,
      ...["-c:v", "libsvtav1", "-crf", "32", "-preset", "6", "-pix_fmt", "yuv420p", "-f", "webm", "o.webm"],
    ]);
    expect(encoderArgs("webm", 1920, 1080, 30, "o.webm", "vp9")).toEqual([
      ...raw,
      ...[
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "32",
        "-b:v",
        "0",
        "-row-mt",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "webm",
        "o.webm",
      ],
    ]);
  });
});
