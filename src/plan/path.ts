import type { SceneLayout } from "../geometry.js";
import type { Keyframe, PlannerParams, Shot, View } from "../schema.js";
import { wideView } from "./framing.js";

/** The shortest camera move, in seconds. */
export const MIN_MOVE = 0.4;

const same = (a: View, b: View) =>
  Math.abs(a.cx - b.cx) < 0.5 && Math.abs(a.cy - b.cy) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-3;

/** Seconds needed to move between two views under the pan-speed and zoom-rate caps. */
export function moveDuration(a: View, b: View, layout: SceneLayout, p: PlannerParams): number {
  const pan = Math.hypot(b.cx - a.cx, b.cy - a.cy) / layout.sceneW / p.maxPanSpeed;
  const zoom = Math.abs(Math.log(b.zoom / a.zoom)) / Math.log(p.maxZoomRate);
  return Math.max(MIN_MOVE, pan, zoom);
}

/** Camera keyframes for the shots (spec §5.3). Times are clamped to [0, duration] and never decrease. */
export function buildKeyframes(
  shots: Shot[],
  layout: SceneLayout,
  p: PlannerParams,
  duration: number,
  loop: boolean,
): Keyframe[] {
  const wide = wideView(layout);
  const kfs: Keyframe[] = [];
  const push = (time: number, v: View) => {
    const last = kfs[kfs.length - 1];
    const t = Math.max(last?.t ?? 0, Math.min(duration, Math.max(0, time)));
    if (last && t - last.t < 1e-6) {
      if (same(last, v)) return;
      const before = kfs[kfs.length - 2];
      if (before && same(before, last)) {
        kfs[kfs.length - 1] = { t, cx: v.cx, cy: v.cy, zoom: v.zoom };
        return;
      }
    }
    kfs.push({ t, cx: v.cx, cy: v.cy, zoom: v.zoom });
  };
  const viaWide = (from: View, leave: number, outD: number, arrive: number, inD: number, to: View) => {
    push(leave, from);
    push(leave + outD, wide);
    push(arrive - inD, wide);
    push(arrive, to);
  };

  let cur: View = wide;
  const first = shots[0];
  if (!loop && first && first.start - p.anticipation < moveDuration(wide, first.view, layout, p)) cur = first.view;
  push(0, cur);
  let free = 0;

  for (const s of shots) {
    const target = s.view;
    const arriveBy = Math.max(0, s.start - p.anticipation);
    const window = arriveBy - free;
    const outD = moveDuration(cur, wide, layout, p);
    const inD = moveDuration(wide, target, layout, p);
    if (same(cur, target)) {
      if (!same(cur, wide) && window >= p.idleWide + outD + inD)
        viaWide(cur, free + p.idleWide, outD, arriveBy, inD, target);
      free = Math.max(free, s.end);
      continue;
    }
    const direct = moveDuration(cur, target, layout, p);
    const zoomJump = Math.abs(Math.log(target.zoom / cur.zoom)) > Math.log(1 + p.panZoomTolerance);
    const goWide =
      !same(cur, wide) &&
      !same(target, wide) &&
      outD + inD <= window &&
      (window >= p.idleWide || (zoomJump && window >= p.zoomOutGap));
    if (goWide) {
      viaWide(cur, free, outD, arriveBy, inD, target);
    } else {
      const leave = Math.max(free, arriveBy - direct);
      push(leave, cur);
      push(leave + direct, target);
    }
    const arrived = (kfs[kfs.length - 1] as Keyframe).t;
    cur = target;
    free = Math.max(s.end, arrived + p.minHold);
  }

  const back = moveDuration(cur, wide, layout, p);
  if (!same(cur, wide) && (loop || duration - free >= p.idleWide)) {
    const leave = loop ? Math.max(free, duration - back) : free;
    push(leave, cur);
    push(leave + back, wide);
    cur = wide;
  }
  push(duration, cur);
  return kfs;
}
