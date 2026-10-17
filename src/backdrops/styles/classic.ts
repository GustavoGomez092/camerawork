import { oklabToLinear, paletteAt } from "../color.js";
import { fbm, rand, TAU } from "../noise.js";
import { across, along } from "../space.js";
import type { StyleDef, StyleParams, Vec3 } from "../types.js";

/** A noise offset of about ±0.5 × distortion that drifts around a closed loop as t goes 0 → 1. */
function wobble(u: number, v: number, t: number, p: StyleParams): number {
  if (p.distortion === 0) return 0;
  const a = TAU * t;
  const x = (u * 1.5) / p.scale + p.speed * Math.cos(a);
  const y = (v * 1.5) / p.scale + p.speed * Math.sin(a);
  return (fbm(p.seed, x, y, 3) - 0.5) * p.distortion;
}

const linear: StyleDef = {
  description: "a straight gradient along the angle",
  colors: ["#0f172a", "#3b82f6", "#a5f3fc"],
  shade(u, v, t, p) {
    const reach = Math.abs(p.uMax * p.sin) + Math.abs(p.vMax * p.cos);
    return paletteAt(p.lab, 0.5 + along(u, v, p) / reach + 0.4 * wobble(u, v, t, p));
  },
};

const radial: StyleDef = {
  description: "a round glow from the centre outwards",
  colors: ["#fde68a", "#f97316", "#1c0a00"],
  shade(u, v, t, p) {
    const du = u - p.uMax / 2;
    const dv = v - p.vMax / 2;
    const r = Math.sqrt(du * du + dv * dv) / (0.5 * Math.hypot(p.uMax, p.vMax) * p.scale);
    return paletteAt(p.lab, r + 0.4 * wobble(u, v, t, p));
  },
};

const conic: StyleDef = {
  description: "colours sweeping around the centre",
  colors: ["#6d28d9", "#ec4899", "#f59e0b", "#06b6d4"],
  shade(u, v, t, p) {
    const turn = 0.15 * p.speed * Math.sin(TAU * t);
    const a = Math.atan2(across(u, v, p), -along(u, v, p)) / TAU + 0.5 + turn + 0.3 * wobble(u, v, t, p);
    const f = a - Math.floor(a);
    return paletteAt(p.lab, 1 - Math.abs(2 * f - 1)); // mirrored, so the sweep has no seam
  },
};

// mesh recomputes its blob centres once per (settings, t), not once per pixel; the output depends only on the inputs.
let blobsFor: StyleParams | null = null;
let blobsAt = Number.NaN;
let blobs: number[] = [];

function meshBlobs(t: number, p: StyleParams): number[] {
  if (blobsFor === p && blobsAt === t) return blobs;
  const a = TAU * t;
  const n = Math.max(3, p.lab.length + 1);
  blobs = [];
  for (let i = 0; i < n; i++) {
    const phase = rand(p.seed, i * 3 + 2) * TAU;
    blobs.push(
      (0.1 + 0.8 * rand(p.seed, i * 3)) * p.uMax + 0.12 * p.speed * Math.cos(a + phase),
      (0.1 + 0.8 * rand(p.seed, i * 3 + 1)) * p.vMax + 0.12 * p.speed * Math.sin(a + phase),
    );
  }
  blobsFor = p;
  blobsAt = t;
  return blobs;
}

const mesh: StyleDef = {
  description: "soft colour blobs blended together (placed by the seed)",
  colors: ["#ff9a9e", "#fecfef", "#a18cd1", "#f6d365"],
  shade(u, v, t, p) {
    const centres = meshBlobs(t, p);
    const wu = u + 0.5 * wobble(u, v, t, p);
    const wv = v + 0.5 * wobble(v + 3.1, u + 7.3, t, p);
    const spread = 2 * (0.32 * p.scale) ** 2;
    let L = 0;
    let A = 0;
    let B = 0;
    let total = 0;
    for (let i = 0; i < centres.length / 2; i++) {
      const du = wu - (centres[2 * i] as number);
      const dv = wv - (centres[2 * i + 1] as number);
      const w = Math.exp(-(du * du + dv * dv) / spread) + 1e-6;
      const c = p.lab[i % p.lab.length] as Vec3;
      L += w * c[0];
      A += w * c[1];
      B += w * c[2];
      total += w;
    }
    return oklabToLinear(L / total, A / total, B / total);
  },
};

export const CLASSIC_STYLES = { linear, radial, conic, mesh };
