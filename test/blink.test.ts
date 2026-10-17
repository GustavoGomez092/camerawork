import { describe, expect, test } from "bun:test";
import { filterBlinks, iou } from "../src/detect/blink.js";
import type { Change } from "../src/schema.js";

const at = (t: number, x = 100): Change => ({ t, rect: [x, 50, 4, 30], strength: 1 });

describe("iou", () => {
  test("identical boxes are 1 and disjoint boxes are 0", () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iou([0, 0, 10, 10], [20, 20, 5, 5])).toBe(0);
  });
});

describe("filterBlinks", () => {
  test("a cursor blinking every 0.53 s in one place is dropped", () => {
    expect(filterBlinks([0.5, 1.03, 1.56, 2.09, 2.62].map((t) => at(t)))).toEqual([]);
  });

  test("typing (moving changes) and a one-off change are kept", () => {
    const typing = [0.1, 0.2, 0.35, 0.5].map((t, i) => at(t, 100 + i * 12));
    const once: Change = { t: 3, rect: [400, 400, 50, 50], strength: 0.8 };
    expect(filterBlinks([...typing, once])).toHaveLength(5);
  });

  test("an irregular repeat in one place is not a blink", () => {
    expect(filterBlinks([0.5, 0.9, 2.4, 2.7].map((t) => at(t)))).toHaveLength(4);
  });

  test("full-frame changes always survive", () => {
    const full = [1, 2, 3].map((t): Change => ({ t, rect: [0, 0, 1920, 1080], strength: 1, fullFrame: true }));
    expect(filterBlinks(full)).toHaveLength(3);
  });
});
