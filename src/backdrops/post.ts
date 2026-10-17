import { hash3, smoothstep } from "./noise.js";

type Pixels = Uint8Array | Uint8ClampedArray;

const clampByte = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);

/** Darkens the edges of opaque RGBA pixels (w×h) in place; strength 0–1 (1 leaves the corners at 15 %). */
export function applyVignette(px: Pixels, w: number, h: number, strength: number): void {
  if (strength <= 0) return;
  const cx = w / 2;
  const cy = h / 2;
  const inv = 1 / Math.hypot(cx, cy);
  let i = 0;
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5 - cy) * inv;
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) * inv;
      const f = 1 - 0.85 * strength * smoothstep(0.3, 1, Math.sqrt(dx * dx + dy * dy));
      px[i] = clampByte((px[i] as number) * f);
      px[i + 1] = clampByte((px[i + 1] as number) * f);
      px[i + 2] = clampByte((px[i + 2] as number) * f);
      i += 4;
    }
  }
}

export interface GrainSettings {
  /** 0–0.3: each pixel moves by up to ±grain × 128 levels, the same on all three channels. */
  grain: number;
  seed: number;
  /** Frame number: 0 for stills; animated backdrops re-seed the grain every frame. */
  frame: number;
  /** Grain cell size in pixels (see grainCell). */
  cell: number;
}

/** Adds seeded monochrome grain to opaque RGBA pixels (w×h) in place. */
export function applyGrain(px: Pixels, w: number, h: number, s: GrainSettings): void {
  if (s.grain <= 0) return;
  const amp = s.grain * 256;
  const seed = (s.seed ^ Math.imul(s.frame + 1, 0x9e3779b1)) >>> 0;
  const cell = Math.max(1, Math.floor(s.cell));
  let i = 0;
  for (let y = 0; y < h; y++) {
    const gy = Math.floor(y / cell);
    for (let x = 0; x < w; x++) {
      const n = (hash3(seed, Math.floor(x / cell), gy) - 0.5) * amp;
      px[i] = clampByte((px[i] as number) + n);
      px[i + 1] = clampByte((px[i + 1] as number) + n);
      px[i + 2] = clampByte((px[i + 2] as number) + n);
      i += 4;
    }
  }
}

/** Grain is sized for a 1920-px-wide scene (like look lengths, ruling R1): one cell per 1920th of the width. */
export const grainCell = (sceneWidth: number): number => Math.max(1, Math.round(sceneWidth / 1920));
