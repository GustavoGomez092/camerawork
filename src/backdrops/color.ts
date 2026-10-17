import type { Vec3 } from "./types.js";

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** `#rrggbb` → linear-light RGB. */
export function hexToLinear(hex: string): Vec3 {
  const n = Number.parseInt(hex.slice(1), 16);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
}

export function linearToOklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToLinear(L: number, a: number, b: number): Vec3 {
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

/** Mixes two OKLab colours (k = 0 → a, 1 → b), multiplies the lightness by `light`, and returns linear RGB. */
export function mixLab(a: Vec3, b: Vec3, k: number, light = 1): Vec3 {
  return oklabToLinear((a[0] + (b[0] - a[0]) * k) * light, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
}

/**
 * The palette colour at x (0–1, clamped; the colours sit at equal steps), mixed in OKLab, with its lightness
 * multiplied by `light` and then raised by `glow` (a sheen), as linear RGB.
 */
export function paletteAt(lab: Vec3[], x: number, light = 1, glow = 0): Vec3 {
  const n = lab.length - 1;
  const f = (x <= 0 ? 0 : x >= 1 ? 1 : x) * n;
  const i = f >= n ? n - 1 : Math.floor(f);
  const k = f - i;
  const a = lab[i] as Vec3;
  const b = lab[i + 1] as Vec3;
  return oklabToLinear((a[0] + (b[0] - a[0]) * k) * light + glow, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
}

const LUT_SIZE = 16384;
const LUT = new Uint8Array(LUT_SIZE + 1);
for (let i = 0; i <= LUT_SIZE; i++) LUT[i] = Math.round(255 * toSrgb(i / LUT_SIZE));

/** Linear-light 0–1 (clamped; NaN counts as 0) → an sRGB byte. */
export function toByte(x: number): number {
  return LUT[x >= 1 ? LUT_SIZE : x > 0 ? Math.round(x * LUT_SIZE) : 0] as number;
}
