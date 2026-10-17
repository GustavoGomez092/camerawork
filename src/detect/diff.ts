import type { Rect } from "../schema.js";

/** 1 where a grayscale pixel changed by more than `threshold`, else 0. */
export function diffMask(prev: Uint8Array, cur: Uint8Array, threshold: number): Uint8Array {
  const mask = new Uint8Array(cur.length);
  for (let i = 0; i < cur.length; i++) if (Math.abs((cur[i] as number) - (prev[i] as number)) > threshold) mask[i] = 1;
  return mask;
}

/** Clears the mask inside each rectangle (analysis pixels), clamped to the frame. */
export function zeroRects(mask: Uint8Array, w: number, h: number, rects: Rect[]): void {
  for (const [rx, ry, rw, rh] of rects) {
    const x0 = Math.max(0, Math.floor(rx));
    const y0 = Math.max(0, Math.floor(ry));
    const x1 = Math.min(w, Math.ceil(rx + rw));
    const y1 = Math.min(h, Math.ceil(ry + rh));
    for (let y = y0; y < y1; y++) mask.fill(0, y * w + x0, y * w + x1);
  }
}

export interface Region {
  rect: Rect;
  count: number;
}

const gap = (a: Rect, b: Rect): number => {
  const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]));
  const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]));
  return Math.max(dx, dy);
};

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
};

/** 8-connected changed areas as bounding boxes, merged while within `mergeDist`, small ones dropped. */
export function findRegions(mask: Uint8Array, w: number, h: number, mergeDist: number, minCount: number): Region[] {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const regions: Region[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let count = 0;
    while (sp > 0) {
      const p = stack[--sp] as number;
      const x = p % w;
      const y = (p - x) / w;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    regions.push({ rect: [minX, minY, maxX - minX + 1, maxY - minY + 1], count });
  }
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < regions.length && !merged; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i] as Region;
        const b = regions[j] as Region;
        if (gap(a.rect, b.rect) <= mergeDist) {
          regions[i] = { rect: union(a.rect, b.rect), count: a.count + b.count };
          regions.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return regions.filter((r) => r.count >= minCount);
}
