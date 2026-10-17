import { STYLES, shaderColors } from "../src/backdrops/index.js";
import type { StyleName } from "../src/backdrops/types.js";
import { lookScale, type SceneLayout } from "../src/geometry.js";
import type { Backdrop, Look, ShaderBackdrop } from "../src/schema.js";

/** The spec's shared defaults (backdrops §2), used when the editor turns another backdrop into a shader. */
export const SHADER_DEFAULTS = {
  angle: 45,
  scale: 1,
  distortion: 0.3,
  seed: 1,
  grain: 0.04,
  vignette: 0,
  motion: { enabled: false, speed: 0.3 },
};

/** A slider: the look setting it edits (a dotted path), its label and its range. */
export interface Range {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  group: "backdrop" | "window";
}

/** Every slider on the page, with the schema's ranges (spec: backdrops §2 and §6). */
export const RANGES: Range[] = [
  { path: "backdrop.angle", label: "Angle", min: 0, max: 360, step: 1, group: "backdrop" },
  { path: "backdrop.scale", label: "Scale", min: 0.2, max: 5, step: 0.05, group: "backdrop" },
  { path: "backdrop.distortion", label: "Distortion", min: 0, max: 1, step: 0.01, group: "backdrop" },
  { path: "backdrop.grain", label: "Grain", min: 0, max: 0.3, step: 0.005, group: "backdrop" },
  { path: "backdrop.vignette", label: "Vignette", min: 0, max: 1, step: 0.01, group: "backdrop" },
  { path: "backdrop.motion.speed", label: "Motion speed", min: 0.05, max: 2, step: 0.05, group: "backdrop" },
  { path: "padding", label: "Padding", min: 0, max: 0.45, step: 0.005, group: "window" },
  { path: "radius", label: "Corner radius", min: 0, max: 80, step: 1, group: "window" },
  { path: "shadow.blur", label: "Shadow blur", min: 0, max: 200, step: 1, group: "window" },
  { path: "shadow.offsetY", label: "Shadow offset", min: -100, max: 100, step: 1, group: "window" },
  { path: "shadow.opacity", label: "Shadow opacity", min: 0, max: 1, step: 0.01, group: "window" },
  { path: "tilt.rotateX", label: "Tilt X", min: -30, max: 30, step: 0.5, group: "window" },
  { path: "tilt.rotateY", label: "Tilt Y", min: -30, max: 30, step: 0.5, group: "window" },
];

/** The backdrop with `style` chosen: a shader keeps its settings and colours; anything else starts from defaults. */
export function shaderFor(style: StyleName, from: Backdrop): ShaderBackdrop {
  if (from.type === "shader") return { ...structuredClone(from), style, colors: [...shaderColors(from)] };
  return { type: "shader", style, colors: [...STYLES[style].colors], ...structuredClone(SHADER_DEFAULTS) };
}

/** A setting by dotted path ("backdrop.motion.speed"); undefined when the look has no such setting. */
export function getPath(look: Look, path: string): unknown {
  let node: unknown = look;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[key];
  return node;
}

/** A copy of the look with one setting changed. */
export function setPath(look: Look, path: string, value: unknown): Look {
  const copy = structuredClone(look) as unknown as Record<string, unknown>;
  const keys = path.split(".");
  let node = copy;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys[keys.length - 1] as string] = value;
  return copy as unknown as Look;
}

/** The look's backdrop colours as the page shows them: a shader's own, or its style's palette when omitted. */
export const currentColors = (look: Look): string[] =>
  look.backdrop.type === "shader" ? [...shaderColors(look.backdrop)] : [];

/** The colours with colour i replaced. */
export const withColor = (colors: string[], i: number, value: string): string[] =>
  colors.map((c, j) => (j === i ? value : c));

/** One more colour (a copy of the last), at most 5. */
export const addColor = (colors: string[]): string[] =>
  colors.length >= 5 ? colors : [...colors, colors[colors.length - 1] as string];

/** Without colour i, at least 2. */
export const removeColor = (colors: string[], i: number): string[] =>
  colors.length <= 2 ? colors : colors.filter((_, j) => j !== i);

/** The look as the page shows it in Copy JSON and sends it to Save. */
export const lookJson = (look: Look): string => `${JSON.stringify(look, null, 2)}\n`;

/** Where and how the window sits in a preview drawn at `s` preview pixels per scene pixel. */
export interface WindowBox {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
  /** CSS transform (with transform-origin 0 0): the layout's tilt homography, exactly as the render warps. */
  transform: string;
  /** CSS box-shadow: blur and offset scaled like the render's (Gaussian sigma = blur / 2). */
  shadow: string;
}

const n = (x: number) => Number(x.toFixed(9));

export function windowBox(layout: SceneLayout, look: Look, s: number): WindowBox {
  const h = layout.h.map((x) => x);
  const k = lookScale(layout.winW) * s;
  // layout.h maps window-local master px to tilted px; in preview px that is S·H·S⁻¹ with S = diag(s, s, 1),
  // written column-major as a CSS matrix3d.
  const m = [h[0], h[3], 0, (h[6] as number) / s, h[1], h[4], 0, (h[7] as number) / s, 0, 0, 1, 0];
  m.push((h[2] as number) * s, (h[5] as number) * s, 0, h[8]);
  return {
    left: layout.winX * s,
    top: layout.winY * s,
    width: layout.winW * s,
    height: layout.winH * s,
    radius: look.radius * k,
    transform: `matrix3d(${m.map((x) => n(x as number)).join(",")})`,
    shadow:
      look.shadow.opacity > 0
        ? `0 ${n(look.shadow.offsetY * k)}px ${n(look.shadow.blur * k)}px rgba(0,0,0,${look.shadow.opacity})`
        : "none",
  };
}
