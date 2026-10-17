import type { StyleParams } from "./types.js";

/** Distance along the pattern's direction from the field's centre, in pattern units (divided by scale). */
export const along = (u: number, v: number, p: StyleParams): number =>
  ((u - p.uMax / 2) * p.sin - (v - p.vMax / 2) * p.cos) / p.scale;

/** Distance across the pattern's direction from the field's centre, in pattern units (divided by scale). */
export const across = (u: number, v: number, p: StyleParams): number =>
  ((u - p.uMax / 2) * p.cos + (v - p.vMax / 2) * p.sin) / p.scale;
