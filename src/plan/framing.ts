import type { SceneLayout } from "../geometry.js";
import type { Rect, View } from "../schema.js";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const wideView = (layout: SceneLayout): View => ({ cx: layout.sceneW / 2, cy: layout.sceneH / 2, zoom: 1 });

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

/** The app window's bounding box in scene pixels (for a tilted look: the warped quad's bounding box). */
export function windowBox(layout: SceneLayout): Rect {
  const xs = layout.quad.map((q) => q[0] + layout.winX);
  const ys = layout.quad.map((q) => q[1] + layout.winY);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}

/**
 * Places a view of `zoom` centred near (cx, cy). Wide (zoom 1) is the whole scene. A zoomed view stays inside the
 * app window, so it never shows the backdrop beside it; in a dimension where the view is larger than the window it is
 * centred on the window. It always stays inside the scene.
 */
export function placeView(cx: number, cy: number, zoom: number, layout: SceneLayout): View {
  const vw = layout.sceneW / zoom;
  const vh = layout.sceneH / zoom;
  if (zoom > 1) {
    const [bx, by, bw, bh] = windowBox(layout);
    cx = vw >= bw ? bx + bw / 2 : clamp(cx, bx + vw / 2, bx + bw - vw / 2);
    cy = vh >= bh ? by + bh / 2 : clamp(cy, by + vh / 2, by + bh - vh / 2);
  }
  return {
    cx: clamp(cx, vw / 2, layout.sceneW - vw / 2),
    cy: clamp(cy, vh / 2, layout.sceneH - vh / 2),
    zoom,
  };
}

/**
 * The smallest scene-aspect view holding `rect` (scene pixels) plus `margin` on each side, zoom in [1, maxZoom],
 * placed by `placeView`.
 */
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
  return placeView(x + w / 2, y + h / 2, zoom, layout);
}

/** The scene rectangle a view shows. */
export function viewRect(v: View, layout: SceneLayout): Rect {
  const vw = layout.sceneW / v.zoom;
  const vh = layout.sceneH / v.zoom;
  return [v.cx - vw / 2, v.cy - vh / 2, vw, vh];
}
