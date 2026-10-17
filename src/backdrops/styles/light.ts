import { oklabToLinear, paletteAt } from "../color.js";
import { fbm, noise2, smoothstep, TAU } from "../noise.js";
import { across, along } from "../space.js";
import type { StyleDef, Vec3 } from "../types.js";

const silk: StyleDef = {
  description: "soft diagonal bands of light with a sheen, like folded fabric",
  colors: ["#12002e", "#7b2bff", "#ff2bd6"],
  shade(u, v, t, p) {
    const a = TAU * t;
    const s = along(u, v, p);
    const q = across(u, v, p);
    const warp = fbm(p.seed, q * 0.8 + 0.5 * p.speed * Math.cos(a), s * 0.8 + 0.5 * p.speed * Math.sin(a), 3) - 0.5;
    const fold = s + 1.2 * p.distortion * warp + 0.25 * Math.sin(q * 1.7 + 0.8 * p.speed * Math.sin(a + 1));
    const band = 0.5 + 0.5 * Math.sin(fold * 6.5);
    const b4 = band * band * band * band;
    const sheen = b4 * b4 * b4;
    return paletteAt(p.lab, 0.5 + 0.5 * Math.sin(fold * 2.3 + 0.4), 0.6 + 0.4 * band, 0.14 * sheen);
  },
};

const waves: StyleDef = {
  description: "layered flowing waves, stacked along the angle",
  colors: ["#0b1d3a", "#1e6091", "#52b69a", "#d9ed92"],
  shade(u, v, t, p) {
    const a = TAU * t;
    const s = along(u, v, p);
    const q = across(u, v, p);
    const layers = 5;
    let x = 0;
    let light = 1;
    for (let k = 0; k < layers; k++) {
      const phase = k * 1.7 + (p.seed % 97) * 0.13;
      const edge =
        (k - (layers - 1) / 2) * 0.22 +
        0.08 * Math.sin(q * (1.8 + 0.6 * k) + phase + 0.9 * p.speed * Math.sin(a + k)) +
        0.3 * p.distortion * (noise2(p.seed + k, q * 1.3 + 0.4 * p.speed * Math.cos(a), k * 7.1) - 0.5);
      const d = s - edge;
      x += smoothstep(-0.012, 0.012, d) / layers;
      const e = d + 0.03;
      light *= 1 - 0.18 * Math.exp(-(e * e) / 0.0012) * (d < 0 ? 1 : 0.4); // a soft shadow under each crest
    }
    return paletteAt(p.lab, x, light);
  },
};

const aurora: StyleDef = {
  description: "wide glowing ribbons over a dark base (the first colour)",
  colors: ["#020617", "#22d3ee", "#a855f7", "#4ade80"],
  shade(u, v, t, p) {
    const a = TAU * t;
    const s = along(u, v, p);
    const q = across(u, v, p);
    const base = p.lab[0] as Vec3;
    let L = base[0];
    let A = base[1];
    let B = base[2];
    const ribbons = Math.max(1, p.lab.length - 1);
    for (let k = 0; k < ribbons; k++) {
      const c = p.lab[Math.min(k + 1, p.lab.length - 1)] as Vec3;
      const centre =
        (k - (ribbons - 1) / 2) * 0.3 +
        0.18 * Math.sin(q * (1.1 + 0.35 * k) + k * 2.1 + 0.7 * p.speed * Math.sin(a + k * 1.3)) +
        0.4 * p.distortion * (fbm(p.seed + k, q * 0.9 + 0.3 * p.speed * Math.cos(a), k * 5.3, 2) - 0.5);
      const d = (s - centre) / 0.22;
      const streak = 0.7 + 0.3 * fbm(p.seed + 31 * k, q * 12 + 0.3 * p.speed * Math.cos(a), s * 0.2, 2);
      const glow = Math.exp(-d * d) * streak;
      L += (c[0] - L) * glow + 0.06 * glow;
      A += (c[1] - A) * glow;
      B += (c[2] - B) * glow;
    }
    return oklabToLinear(L, A, B);
  },
};

export const LIGHT_STYLES = { silk, waves, aurora };
