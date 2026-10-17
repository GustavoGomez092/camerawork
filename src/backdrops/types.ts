/** Three floats: linear-light RGB (each 0–1) or OKLab (L, a, b), as named where used. */
export type Vec3 = [number, number, number];

export const STYLE_NAMES = [
  "silk",
  "waves",
  "aurora",
  "mesh",
  "stripes",
  "ripple",
  "linear",
  "radial",
  "conic",
] as const;
export type StyleName = (typeof STYLE_NAMES)[number];

/** A shader backdrop's settings, resolved for one field size, in the form the styles use. */
export interface StyleParams {
  /** The palette in OKLab, 2–5 colours. */
  lab: Vec3[];
  /** sin and cos of the angle. The pattern runs along (sin, -cos): 0° points up and 90° right, as in CSS. */
  sin: number;
  cos: number;
  /** Pattern size: 2 makes every feature twice as large. */
  scale: number;
  distortion: number;
  /** An unsigned 32-bit seed. */
  seed: number;
  /** The motion orbit's size: motion.speed when motion is enabled, else 0 (then every t gives the same picture). */
  speed: number;
  /** The field's extent: u runs 0–uMax and v 0–vMax; the shorter one is 1. */
  uMax: number;
  vMax: number;
}

/**
 * A background style: linear-light RGB (0–1; the caller clamps) at aspect-corrected (u, v) and loop time t in [0, 1).
 * Pure and periodic in t: every time term is sin/cos of 2πt·k for a whole number k, so t = 1 equals t = 0.
 */
export type ShadeFn = (u: number, v: number, t: number, p: StyleParams) => Vec3;

export interface StyleDef {
  /** One line for `camerawork looks` and the editor. */
  description: string;
  /** The palette used when a backdrop gives no colours. */
  colors: string[];
  shade: ShadeFn;
}
