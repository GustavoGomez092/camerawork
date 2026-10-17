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
      // At the very end of the video a move that cannot finish is compressed: the final view replaces the
      // keyframe already sitting at `duration`, so the last movement is one single move (never a hard cut).
      if ((before && same(before, last)) || t >= duration - 1e-6) {
        kfs[kfs.length - 1] = { t, cx: v.cx, cy: v.cy, zoom: v.zoom };
        return;
      }
    }
    kfs.push({ t, cx: v.cx, cy: v.cy, zoom: v.zoom });
  };
  /** Leave `from` at `leave`, ease to `mid`, hold it, and ease into `to` exactly at `arrive`. */
  const via = (from: View, leave: number, mid: View, arrive: number, to: View) => {
    push(leave, from);
    push(leave + moveDuration(from, mid, layout, p), mid);
    push(arrive - moveDuration(mid, to, layout, p), mid);
    push(arrive, to);
  };
  /** The widest in-between view (zoom below both ends) that both halves of a move can reach inside `window`. */
  const partialWide = (from: View, to: View, window: number): View | undefined => {
    const top = Math.min(from.zoom, to.zoom);
    for (let zm = 1.05; zm < top; zm *= 1.05) {
      const m = midView(from, to, zm);
      if (moveDuration(from, m, layout, p) + moveDuration(m, to, layout, p) <= window) return m;
    }
    return undefined;
  };
  const midView = (a: View, b: View, zm: number): View => {
    const vw = layout.sceneW / zm;
    const vh = layout.sceneH / zm;
    return {
      cx: Math.min(layout.sceneW - vw / 2, Math.max(vw / 2, (a.cx + b.cx) / 2)),
      cy: Math.min(layout.sceneH - vh / 2, Math.max(vh / 2, (a.cy + b.cy) / 2)),
      zoom: zm,
    };
  };

  let cur: View = wide;
  const first = shots[0];
  if (!loop && first && first.start - p.anticipation < moveDuration(wide, first.view, layout, p)) cur = first.view;
  push(0, cur);
  let free = 0; // earliest the camera may leave its current view
  let prevEnd = 0; // end of the last shot: idle time is counted from here

  for (const s of shots) {
    const target = s.view;
    const arriveBy = Math.max(0, s.start - p.anticipation);
    const window = arriveBy - free;
    const outD = moveDuration(cur, wide, layout, p);
    const inD = moveDuration(wide, target, layout, p);
    const idleLeave = Math.max(free, prevEnd + p.idleWide);
    const idleFits = idleLeave + outD + inD <= arriveBy;
    if (same(cur, target)) {
      if (!same(cur, wide) && idleFits) {
        via(cur, idleLeave, wide, arriveBy, target);
        free = Math.max(s.end, arriveBy + p.minHold);
      } else free = Math.max(free, s.end);
      prevEnd = Math.max(prevEnd, s.end);
      continue;
    }
    const direct = moveDuration(cur, target, layout, p);
    const zoomJump = Math.abs(Math.log(target.zoom / cur.zoom)) > Math.log(1 + p.panZoomTolerance);
    const zoomed = !same(cur, wide) && !same(target, wide);
    const mid = zoomed && zoomJump && window >= p.zoomOutGap ? partialWide(cur, target, window) : undefined;
    if (zoomed && idleFits) {
      via(cur, idleLeave, wide, arriveBy, target);
    } else if (zoomed && zoomJump && window >= p.zoomOutGap && outD + inD <= window) {
      via(cur, free, wide, arriveBy, target);
    } else if (mid) {
      via(cur, free, mid, arriveBy, target);
    } else {
      const leave = Math.max(free, arriveBy - direct);
      push(leave, cur);
      push(leave + direct, target);
    }
    const arrived = (kfs[kfs.length - 1] as Keyframe).t;
    cur = target;
    free = Math.max(s.end, arrived + p.minHold);
    prevEnd = Math.max(prevEnd, s.end);
  }

  const back = moveDuration(cur, wide, layout, p);
  if (!same(cur, wide)) {
    const drift = Math.max(free, prevEnd + p.idleWide);
    if (loop) {
      const leave = Math.max(free, duration - back);
      push(leave, cur);
      push(leave + back, wide);
      cur = wide;
    } else if (drift + back <= duration) {
      push(drift, cur);
      push(drift + back, wide);
      cur = wide;
    }
  }
  push(duration, cur);
  return kfs;
}
