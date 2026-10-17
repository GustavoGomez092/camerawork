import type { Look, Rect } from "./schema.js";

export type Point = [number, number];
export type Quad = [Point, Point, Point, Point];

/** Black border added around the window before the perspective warp (ruling R7). */
export const WARP_BORDER = 8;

/** Look lengths are defined at a 1920-px-wide window (ruling R1). */
export const lookScale = (windowWidth: number): number => windowWidth / 1920;

const even = (n: number): number => (n % 2 === 0 ? n : n + 1);

/** The window's corners (TL, TR, BL, BR) after rotating about X then Y with a perspective, fitted inside w×h. */
export function tiltQuad(w: number, h: number, tilt: Look["tilt"]): Quad {
  if (tilt.rotateX === 0 && tilt.rotateY === 0)
    return [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ];
  const d = tilt.perspective * lookScale(w);
  const rx = (tilt.rotateX * Math.PI) / 180;
  const ry = (tilt.rotateY * Math.PI) / 180;
  const corners: Point[] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [-w / 2, h / 2],
    [w / 2, h / 2],
  ];
  const projected = corners.map(([x, y]): Point => {
    const y1 = y * Math.cos(rx);
    const z1 = y * Math.sin(rx);
    const x2 = x * Math.cos(ry) + z1 * Math.sin(ry);
    const z2 = -x * Math.sin(ry) + z1 * Math.cos(ry);
    const s = d / (d - z2);
    return [x2 * s, y1 * s];
  });
  const xs = projected.map((p) => p[0]);
  const ys = projected.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const k = Math.min(w / (maxX - minX), h / (maxY - minY), 1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return projected.map(([x, y]): Point => [w / 2 + (x - cx) * k, h / 2 + (y - cy) * k]) as Quad;
}

/** Gauss–Jordan elimination with partial pivoting for a small dense system a·x = b. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] as number]);
  const at = (r: number, c: number) => (m[r] as number[])[c] as number;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(at(r, col)) > Math.abs(at(pivot, col))) pivot = r;
    const tmp = m[col] as number[];
    m[col] = m[pivot] as number[];
    m[pivot] = tmp;
    const pivotRow = m[col] as number[];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = m[r] as number[];
      const f = (row[col] as number) / (pivotRow[col] as number);
      for (let c = col; c <= n; c++) row[c] = (row[c] as number) - f * (pivotRow[c] as number);
    }
  }
  return m.map((row, i) => (row[n] as number) / (row[i] as number));
}

/** The 3×3 projective transform (row-major, h[8] = 1) taking each src corner to the matching dst corner. */
export function homography(src: Quad, dst: Quad): number[] {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i] as Point;
    const [u, v] = dst[i] as Point;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return [...solve(a, b), 1];
}

export function applyH(h: number[], [x, y]: Point): Point {
  const g = (i: number) => h[i] as number;
  const w = g(6) * x + g(7) * y + g(8);
  return [(g(0) * x + g(1) * y + g(2)) / w, (g(3) * x + g(4) * y + g(5)) / w];
}

export interface SceneLayout {
  sceneW: number;
  sceneH: number;
  winX: number;
  winY: number;
  winW: number;
  winH: number;
  /** The tilted window corners in window-local pixels (before WARP_BORDER). */
  quad: Quad;
  /** Window-local master pixels → window-local tilted pixels. */
  h: number[];
}

/** Places the master (1:1 pixels) inside a backdrop with `look.padding` on each side, grown to `aspect`. */
export function sceneLayout(master: { width: number; height: number }, look: Look, aspect: number): SceneLayout {
  const winW = master.width;
  const winH = master.height;
  const fit = 1 - 2 * look.padding;
  let sceneW = even(Math.ceil(winW / fit));
  let sceneH = even(Math.ceil(winH / fit));
  if (sceneW / sceneH < aspect - 1e-9) sceneW = even(Math.ceil(sceneH * aspect));
  else if (sceneW / sceneH > aspect + 1e-9) sceneH = even(Math.ceil(sceneW / aspect));
  const quad = tiltQuad(winW, winH, look.tilt);
  const h = homography(
    [
      [0, 0],
      [winW, 0],
      [0, winH],
      [winW, winH],
    ],
    quad,
  );
  return {
    sceneW,
    sceneH,
    winX: Math.round((sceneW - winW) / 2),
    winY: Math.round((sceneH - winH) / 2),
    winW,
    winH,
    quad,
    h,
  };
}

export function masterToScene(layout: SceneLayout, p: Point): Point {
  const [u, v] = applyH(layout.h, p);
  return [u + layout.winX, v + layout.winY];
}

/** The scene-pixel bounding box of a master-pixel rectangle. */
export function mapRect(layout: SceneLayout, [x, y, w, h]: Rect): Rect {
  const corners: Point[] = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ];
  const pts = corners.map((p) => masterToScene(layout, p));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const round = (n: number) => Math.round(n * 100) / 100;
  return [round(minX), round(minY), round(Math.max(...xs) - minX), round(Math.max(...ys) - minY)];
}
