import type { Backdrop, ShaderBackdrop } from "../schema.js";
import type { StyleName } from "./types.js";

export interface BackdropPreset {
  /** "<style>: <what it looks like>", shown by `camerawork looks` and the editor. */
  description: string;
  backdrop: Backdrop;
}

/** The `hero` look's measured gradient (ruling R2 of the engine plan). */
export const HERO_BACKDROP: Backdrop = {
  type: "gradient",
  angle: 180,
  stops: [
    { at: 0, color: "#8f8f8f" },
    { at: 0.27, color: "#c4c4c4" },
    { at: 0.42, color: "#1a1a1a" },
    { at: 1, color: "#0e0e0e" },
  ],
};

const shader = (
  style: StyleName,
  colors: string[],
  angle: number,
  more: Partial<Omit<ShaderBackdrop, "type" | "style" | "colors" | "angle">> = {},
): ShaderBackdrop => ({
  type: "shader",
  style,
  colors,
  angle,
  scale: 1,
  distortion: 0.35,
  seed: 1,
  grain: 0.05,
  vignette: 0.15,
  motion: { enabled: false, speed: 0.3 },
  ...more,
});

/** Named backdrops. `--look <name>` puts the hero window (padding, radius, shadow) on one of these. */
export const BACKDROPS: Record<string, BackdropPreset> = {
  ultraviolet: {
    description: "silk: deep violet folds with a magenta sheen",
    backdrop: shader("silk", ["#12002e", "#7b2bff", "#ff2bd6"], 62, { distortion: 0.4, seed: 7, vignette: 0.2 }),
  },
  glacier: {
    description: "silk: icy blue folds",
    backdrop: shader("silk", ["#03142b", "#2b6cb0", "#bfe9ff"], 120, { seed: 3 }),
  },
  raspberry: {
    description: "silk: dark berry folds with pink light",
    backdrop: shader("silk", ["#2a0010", "#c2185b", "#ff8fb1"], 35, { seed: 11 }),
  },
  frost: {
    description: "silk: pale silver-blue folds (a light backdrop)",
    backdrop: shader("silk", ["#dbe6f0", "#eef3f8", "#ffffff"], 140, { seed: 5, grain: 0.03, vignette: 0 }),
  },
  chrome: {
    description: "silk: polished metal grays",
    backdrop: shader("silk", ["#0b0b0c", "#55575c", "#e4e6ea"], 75, { seed: 9, distortion: 0.5 }),
  },
  aurora: {
    description: "aurora: cyan, violet and green ribbons on a night sky",
    backdrop: shader("aurora", ["#020617", "#22d3ee", "#a855f7", "#4ade80"], 20, {
      seed: 4,
      distortion: 0.5,
      vignette: 0.25,
    }),
  },
  dusk: {
    description: "stripes: sunset bands of coral and orange",
    backdrop: shader("stripes", ["#1b1033", "#ff5e62", "#ff9966"], 55, { seed: 2 }),
  },
  midnight: {
    description: "stripes: deep blue bands",
    backdrop: shader("stripes", ["#050816", "#1e3a8a", "#312e81"], 140, { seed: 6, vignette: 0.3 }),
  },
  ember: {
    description: "stripes: glowing red, orange and gold bands",
    backdrop: shader("stripes", ["#140400", "#b91c1c", "#f97316", "#fbbf24"], 30, { seed: 8 }),
  },
  graphite: {
    description: "stripes: quiet dark-gray bands",
    backdrop: shader("stripes", ["#0e0e0f", "#26272b", "#45474d"], 60, { seed: 12, grain: 0.06 }),
  },
  petal: {
    description: "mesh: soft pink, lilac and peach blobs",
    backdrop: shader("mesh", ["#ff9a9e", "#fecfef", "#a18cd1", "#fbc2eb", "#f6d365"], 45, {
      seed: 21,
      grain: 0.04,
      vignette: 0,
    }),
  },
  "ripple-sea": {
    description: "ripple: blue zig-zag water",
    backdrop: shader("ripple", ["#03045e", "#0077b6", "#90e0ef"], 15, { seed: 13 }),
  },
  solar: {
    description: "waves: warm layered dunes",
    backdrop: shader("waves", ["#2b0a00", "#c2410c", "#f59e0b", "#fde68a"], 10, { seed: 14 }),
  },
  horizon: {
    description: "linear: night sky fading to day",
    backdrop: shader("linear", ["#0f172a", "#1e40af", "#7dd3fc"], 180, { distortion: 0.2 }),
  },
  halo: {
    description: "radial: a warm glow behind the window",
    backdrop: shader("radial", ["#fff1c1", "#f97316", "#1c0a00"], 0, { scale: 1.2, distortion: 0.2, vignette: 0 }),
  },
  prism: {
    description: "conic: a colour wheel sweep",
    backdrop: shader("conic", ["#6d28d9", "#ec4899", "#f59e0b", "#06b6d4"], 30, { distortion: 0.2 }),
  },
  hero: { description: "gradient: the hero look's gray sky-to-ground gradient", backdrop: HERO_BACKDROP },
  solid: { description: "solid: plain near-black", backdrop: { type: "solid", color: "#0e0e0e" } },
  none: { description: "none: black around the window", backdrop: { type: "none" } },
};
