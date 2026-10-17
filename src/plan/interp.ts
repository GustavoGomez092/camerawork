import type { Keyframe, View } from "../schema.js";

export const easeInOutCubic = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

const view = (k: Keyframe): View => ({ cx: k.cx, cy: k.cy, zoom: k.zoom });

/**
 * The camera at time t: eased between keyframes, zoom geometric (constant perceived speed), center linear.
 * The geometric mean of zooms keeps the view inside the scene whenever both endpoint views are.
 */
export function cameraAt(keyframes: Keyframe[], t: number): View {
  const first = keyframes[0] as Keyframe;
  const last = keyframes[keyframes.length - 1] as Keyframe;
  if (t <= first.t) return view(first);
  if (t >= last.t) return view(last);
  let i = 0;
  while (i < keyframes.length - 2 && (keyframes[i + 1] as Keyframe).t <= t) i++;
  const a = keyframes[i] as Keyframe;
  const b = keyframes[i + 1] as Keyframe;
  if (b.t === a.t) return view(b);
  const u = easeInOutCubic((t - a.t) / (b.t - a.t));
  return {
    cx: a.cx + (b.cx - a.cx) * u,
    cy: a.cy + (b.cy - a.cy) * u,
    zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * u),
  };
}
