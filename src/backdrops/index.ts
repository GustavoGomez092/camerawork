import type { ShaderBackdrop } from "../schema.js";
import { hexToLinear, linearToOklab } from "./color.js";
import { renderField } from "./field.js";
import { applyVignette } from "./post.js";
import { CLASSIC_STYLES } from "./styles/classic.js";
import { LIGHT_STYLES } from "./styles/light.js";
import { PATTERN_STYLES } from "./styles/pattern.js";
import type { StyleDef, StyleName, StyleParams } from "./types.js";

export { STYLE_NAMES, type StyleName } from "./types.js";

/** Every background style by name (spec: backdrops §2). */
export const STYLES: Record<StyleName, StyleDef> = { ...LIGHT_STYLES, ...PATTERN_STYLES, ...CLASSIC_STYLES };

/** The backdrop's colours, or its style's palette when it gives none. */
export const shaderColors = (bd: ShaderBackdrop): string[] => bd.colors ?? STYLES[bd.style].colors;

/** Resolves a shader backdrop's settings for a w×h field. */
export function styleParams(bd: ShaderBackdrop, w: number, h: number): StyleParams {
  const rad = (bd.angle * Math.PI) / 180;
  const short = Math.min(w, h);
  return {
    lab: shaderColors(bd).map((c) => linearToOklab(hexToLinear(c))),
    sin: Math.sin(rad),
    cos: Math.cos(rad),
    scale: bd.scale,
    distortion: bd.distortion,
    seed: bd.seed >>> 0,
    speed: bd.motion.enabled ? bd.motion.speed : 0,
    uMax: w / short,
    vMax: h / short,
  };
}

/**
 * The backdrop as opaque RGBA bytes, w×h, at loop time t (0 for a still), vignette included. Grain is not: it is
 * added at full size by whoever shows the result (spec: backdrops §2, §4).
 */
export function shaderField(
  bd: ShaderBackdrop,
  w: number,
  h: number,
  t: number,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const px = renderField(STYLES[bd.style].shade, styleParams(bd, w, h), w, h, t, out);
  applyVignette(px, w, h, bd.vignette);
  return px;
}
