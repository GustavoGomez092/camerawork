import { describe, expect, test } from "bun:test";
import { diffMask, findRegions, zeroRects } from "../src/detect/diff.js";

const W = 20;
const H = 10;
const frame = (fill: (x: number, y: number) => number) => {
  const f = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = fill(x, y);
  return f;
};
const blank = frame(() => 30);

describe("diffMask", () => {
  test("marks only pixels that changed by more than the threshold", () => {
    const cur = frame((x, y) => (x === 3 && y === 4 ? 200 : x === 5 && y === 5 ? 40 : 30));
    const m = diffMask(blank, cur, 12);
    expect(m[4 * W + 3]).toBe(1);
    expect(m[5 * W + 5]).toBe(0);
    expect(m.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe("findRegions", () => {
  test("one solid block is one region with its bounding box and pixel count", () => {
    const m = diffMask(
      blank,
      frame((x, y) => (x >= 2 && x < 6 && y >= 1 && y < 4 ? 255 : 30)),
      12,
    );
    expect(findRegions(m, W, H, 0, 1)).toEqual([{ rect: [2, 1, 4, 3], count: 12 }]);
  });

  test("blocks within the merge distance merge; farther ones stay apart", () => {
    // Pixels at x=1 and x=4 on row 1 are 2 columns apart (gap 2 = mergeDist): merged.
    const two = frame((x, y) => (((x === 1 || x === 4) && y === 1) || (x === 15 && y === 8) ? 255 : 30));
    const regions = findRegions(diffMask(blank, two, 12), W, H, 2, 1);
    expect(regions.map((r) => r.rect)).toEqual([
      [1, 1, 4, 1],
      [15, 8, 1, 1],
    ]);
  });

  test("regions below the minimum pixel count are dropped", () => {
    const m = diffMask(
      blank,
      frame((x, y) => (x === 0 && y === 0 ? 255 : 30)),
      12,
    );
    expect(findRegions(m, W, H, 0, 2)).toEqual([]);
  });

  test("zeroRects masks an area out", () => {
    const m = diffMask(
      blank,
      frame((_x, y) => (y === 0 ? 255 : 30)),
      12,
    );
    zeroRects(m, W, H, [[0, 0, 10, 1]]);
    expect(findRegions(m, W, H, 0, 1).map((r) => r.rect)).toEqual([[10, 0, 10, 1]]);
  });
});
