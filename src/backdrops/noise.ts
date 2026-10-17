export const TAU = Math.PI * 2;

/** A well-mixed 32-bit hash of integer (seed, x, y) as a float in [0, 1). Same inputs, same output. */
export function hash3(seed: number, x: number, y: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(x | 0, 0xc2b2ae35) ^ Math.imul(y | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** The n-th random number in [0, 1) for a seed (blob positions and the like). */
export const rand = (seed: number, n: number): number => hash3(seed, n, 0x5bd1e995);

const tables = new Map<number, Float32Array>();

/** 256×256 random lattice values for a seed, built once and cached (the last 16 seeds). */
function lattice(seed: number): Float32Array {
  let table = tables.get(seed);
  if (table) return table;
  table = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) table[i] = hash3(seed, i & 255, i >> 8);
  if (tables.size >= 16) tables.delete(tables.keys().next().value as number);
  tables.set(seed, table);
  return table;
}

/** Smooth value noise in [0, 1]; it repeats every 256 units. */
export function noise2(seed: number, x: number, y: number): number {
  const table = lattice(seed);
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = xi & 255;
  const x1 = (x0 + 1) & 255;
  const y0 = (yi & 255) << 8;
  const y1 = (y0 + 256) & 0xff00;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const a = table[y0 | x0] as number;
  const b = table[y0 | x1] as number;
  const c = table[y1 | x0] as number;
  const d = table[y1 | x1] as number;
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal noise: `octaves` layers of value noise, each twice as fine and half as strong, in [0, 1]. */
export function fbm(seed: number, x: number, y: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(seed, x, y);
    norm += amp;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 3.7;
    amp *= 0.5;
  }
  return sum / norm;
}

export function smoothstep(a: number, b: number, x: number): number {
  const k = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return k * k * (3 - 2 * k);
}

/** A triangle wave with period 1: 0 at whole numbers, 1 halfway. */
export const tri = (x: number): number => 1 - Math.abs(2 * (x - Math.floor(x)) - 1);
