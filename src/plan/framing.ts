import type { SceneLayout } from "../geometry.js";
import type { Rect, View } from "../schema.js";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const wideView = (layout: SceneLayout): View => ({ cx: layout.sceneW / 2, cy: layout.sceneH / 2, zoom: 1 });

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

/** The smallest scene-aspect view holding `rect` (scene pixels) plus `margin` on each side, zoom in [1, maxZoom]. */
export function frameRect(
  rect: Rect,
  layout: SceneLayout,
  margin: number,
  maxZoom: number,
  zoomOverride?: number,
): View {
  const aspect = layout.sceneW / layout.sceneH;
  const [x, y, w, h] = rect;
  const needW = Math.max(w * (1 + 2 * margin), h * (1 + 2 * margin) * aspect);
  const zoom = clamp(zoomOverride ?? layout.sceneW / needW, 1, maxZoom);
  const vw = layout.sceneW / zoom;
  const vh = layout.sceneH / zoom;
  return {
    cx: clamp(x + w / 2, vw / 2, layout.sceneW - vw / 2),
    cy: clamp(y + h / 2, vh / 2, layout.sceneH - vh / 2),
    zoom,
  };
}
