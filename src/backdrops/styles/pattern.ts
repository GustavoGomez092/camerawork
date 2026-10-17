import { mixLab } from "../color.js";
import { fbm, rand, smoothstep, TAU, tri } from "../noise.js";
import { across, along } from "../space.js";
import type { StyleDef, Vec3 } from "../types.js";

const stripes: StyleDef = {
  description: "crisp diagonal bands with soft edges and depth shading",
  colors: ["#1b1033", "#ff5e62", "#ff9966"],
  shade(u, v, t, p) {
    const a = TAU * t;
    const s = along(u, v, p);
    const q = across(u, v, p);
    const bend = 0.6 * p.distortion * (fbm(p.seed, q * 0.7 + 0.3 * p.speed * Math.cos(a), s * 0.7, 2) - 0.5);
    const pos = (q + bend + 0.12 * p.speed * Math.sin(a)) * 3.2;
    const i = Math.floor(pos);
    const f = pos - i;
    const n = p.lab.length;
    const here = p.lab[((i % n) + n) % n] as Vec3;
    const next = p.lab[(((i + 1) % n) + n) % n] as Vec3;
    const edge = smoothstep(0.9, 1, f);
    return mixLab(here, next, edge, 0.72 + 0.38 * f * (1 - edge)); // each band brightens towards its far edge
  },
};

const ripple: StyleDef = {
  description: "zig-zag interference ripples",
  colors: ["#03045e", "#0077b6", "#90e0ef"],
  shade(u, v, t, p) {
    const a = TAU * t;
    const s = along(u, v, p);
    const q = across(u, v, p);
    const zig = 0.18 * tri(q * 1.4);
    const cq = (rand(p.seed, 1) - 0.5) * p.uMax;
    const cs = (rand(p.seed, 2) - 0.5) * p.vMax;
    const r = Math.hypot(q - cq, s - cs);
    const nx = q * 0.8 + 0.3 * p.speed * Math.cos(a);
    const ny = s * 0.8 + 0.3 * p.speed * Math.sin(a);
    const warp = 0.5 * p.distortion * (fbm(p.seed, nx, ny, 2) - 0.5);
    const w1 = tri((s + zig + warp) * 4 + 0.25 * p.speed * Math.sin(a));
    const w2 = tri((r + warp) * 3 - 0.25 * p.speed * Math.sin(a));
    const f = (0.5 * w1 + 0.5 * w2) * (p.lab.length - 1);
    const i = Math.min(p.lab.length - 2, Math.floor(f));
    return mixLab(p.lab[i] as Vec3, p.lab[i + 1] as Vec3, f - i, 0.8 + 0.2 * w1);
  },
};

export const PATTERN_STYLES = { stripes, ripple };
