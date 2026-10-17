import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { detect } from "../src/detect/index.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

describe("detect on a 4K master", () => {
  test("glyph-sized boxes typed one after another along a line are each detected (F1)", async () => {
    const path = join(tmpDir(), "typing-4k.mp4");
    const typed = [0, 1, 2, 3, 4, 5].map((i) => ({
      x: 1200 + i * 36,
      y: 1000,
      size: 30,
      w: 30,
      h: 40,
      from: 0.6 + i * 0.2,
      to: 3,
      color: "white",
    }));
    await makeBoxVideo(path, { width: 3840, height: 2160, fps: 15, seconds: 2.4, boxes: typed });
    const result = await detect(path);
    for (const box of typed) {
      const hit = result.changes.find(
        (c) => Math.abs(c.t - box.from) < 0.1 && c.rect[0] <= box.x + 30 && c.rect[0] + c.rect[2] >= box.x,
      );
      expect(hit, `glyph at x=${box.x}, t=${box.from}`).toBeDefined();
    }
  }, 60000);
});
