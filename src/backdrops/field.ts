import { toByte } from "./color.js";
import type { ShadeFn, StyleParams } from "./types.js";

/** The long side of the reduced-size field a shader backdrop is computed at (spec §4). */
export const FIELD_MAX = 1280;

/** The field size for a w×h target: the same aspect, the long side at most `max`, both sides even and ≥ 2. */
export function fieldSize(w: number, h: number, max = FIELD_MAX): [number, number] {
  const k = Math.min(1, max / Math.max(w, h));
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return [even(w), even(h)];
}

/**
 * Renders a style as opaque RGBA bytes, w×h, at loop time t. Pixel centres map to (u, v) with the short side
 * spanning 0–1, so the same settings give the same picture at any resolution. `out` is reused when given.
 */
export function renderField(
  shade: ShadeFn,
  p: StyleParams,
  w: number,
  h: number,
  t: number,
  out: Uint8ClampedArray = new Uint8ClampedArray(w * h * 4),
): Uint8ClampedArray {
  const k = 1 / Math.min(w, h);
  let i = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * k;
    for (let x = 0; x < w; x++) {
      const c = shade((x + 0.5) * k, v, t, p);
      out[i] = toByte(c[0]);
      out[i + 1] = toByte(c[1]);
      out[i + 2] = toByte(c[2]);
      out[i + 3] = 255;
      i += 4;
    }
  }
  return out;
}
