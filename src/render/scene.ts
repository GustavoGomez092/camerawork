import { type SceneLayout, WARP_BORDER } from "../geometry.js";
import type { LookAssets } from "./assets.js";

const n = (v: number) => (Math.round(v * 100) / 100).toString();

/** The ffmpeg `perspective` filter for the layout's tilt, in WARP_BORDER-padded coordinates; null when untilted. */
export function perspectiveExpr(layout: SceneLayout): string | null {
  const [tl, tr, bl, br] = layout.quad;
  const untilted =
    tl[0] === 0 &&
    tl[1] === 0 &&
    tr[0] === layout.winW &&
    tr[1] === 0 &&
    bl[0] === 0 &&
    bl[1] === layout.winH &&
    br[0] === layout.winW &&
    br[1] === layout.winH;
  if (untilted) return null;
  const B = WARP_BORDER;
  const pts = layout.quad.map(([x, y], i) => `x${i}=${n(x + B)}:y${i}=${n(y + B)}`).join(":");
  return `perspective=${pts}:sense=destination:interpolation=cubic`;
}

/**
 * readFrames args producing RGBA scene frames: backdrop, shadow, then the masked (and warped) window.
 * With no mask (only when the window is the whole scene) the master passes straight through.
 */
export function sceneArgs(masterPath: string, layout: SceneLayout, assets: LookAssets, fps: number): string[] {
  if (!assets.mask) return ["-i", masterPath, "-an", "-vf", `fps=${fps},format=rgba`, "-pix_fmt", "rgba"];
  const B = WARP_BORDER;
  const perspective = perspectiveExpr(layout);
  const inputs = ["-i", masterPath, "-loop", "1", "-i", assets.backdrop, "-loop", "1", "-i", assets.mask];
  const graph = [
    `[0:v]fps=${fps},format=rgb24,pad=iw+${2 * B}:ih+${2 * B}:${B}:${B}:black${perspective ? `,${perspective}` : ""},format=rgba[v]`,
    "[2:v]format=gray[m]",
    "[v][m]alphamerge=shortest=1[w]",
    "[1:v]format=rgba[bg]",
  ];
  let base = "bg";
  if (assets.shadow) {
    inputs.push("-loop", "1", "-i", assets.shadow);
    graph.push(`[bg][3:v]overlay=${assets.shadowX}:${assets.shadowY}[bs]`);
    base = "bs";
  }
  graph.push(`[${base}][w]overlay=${layout.winX - B}:${layout.winY - B}:shortest=1,format=rgba[out]`);
  return [...inputs, "-an", "-filter_complex", graph.join(";"), "-map", "[out]", "-pix_fmt", "rgba"];
}
