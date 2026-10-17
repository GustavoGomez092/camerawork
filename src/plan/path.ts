import type { SceneLayout } from "../geometry.js";
import type { Keyframe, PlannerParams, Shot, View } from "../schema.js";
import { placeView, viewRect, wideView, windowBox } from "./framing.js";
import { contains, weightOf } from "./shots.js";

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

/** Share of the view's width kept as an inset when deciding a target is already in view. */
const IN_VIEW_INSET = 0.02;

/** A shot as the path sees it: with its weight (changed pixels) when the planner measured one. */
export type PathShot = Shot & { weight?: number };

/**
 * Camera keyframes for the shots (spec §5.3). Times are clamped to [0, duration] and never decrease.
 *
 * Auto shots compete for the camera (cue shots never are skipped):
 * - an auto shot that starts while the camera is on a longer shot is ignored unless it is more salient (heavier);
 *   a more salient one may cut the current shot's hold to `minHold`;
 * - a stale auto shot, one the camera can only reach after `end + minHold`, is skipped;
 * - an auto shot whose visit would make a later, more salient shot unreachable by that shot's `end + minHold` (while
 *   skipping it keeps that shot reachable) is skipped: later, larger changes win;
 * - a shot is visited only if the camera can still get there before the video ends (in a loop: and get back to wide);
 * - while zoomed in, an auto shot whose target is already inside the view (less a small inset) and whose zoom is
 *   within panZoomTolerance of the current one does not move the camera: the current view is kept and its hold
 *   extended (R-b), unless an idle drift to wide comes first (then the shot gets its own framing).
 */
export function buildKeyframes(
  shots: PathShot[],
  layout: SceneLayout,
  p: PlannerParams,
  duration: number,
  loop: boolean,
): Keyframe[] {
  const wide = wideView(layout);
  const kfs: Keyframe[] = [];
  const move = (a: View, b: View) => moveDuration(a, b, layout, p);
  const push = (time: number, v: View) => {
    const last = kfs[kfs.length - 1];
    const t = Math.max(last?.t ?? 0, Math.min(duration, Math.max(0, time)));
    if (last && t - last.t < 1e-6) {
      if (same(last, v)) return;
      const before = kfs[kfs.length - 2];
      // Only when the video is too short for a capped move (or a cue cannot be honoured otherwise): the final view
      // replaces the keyframe already sitting at `duration`, so the last movement is one single move (never a cut).
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
    push(leave + move(from, mid), mid);
    push(arrive - move(mid, to), mid);
    push(arrive, to);
  };
  const midView = (a: View, b: View, zm: number): View => placeView((a.cx + b.cx) / 2, (a.cy + b.cy) / 2, zm, layout);
  const [bx, by, bw, bh] = windowBox(layout);
  /**
   * Is `rect` already well inside the zoomed view `v`? An inset of IN_VIEW_INSET of the view width is kept on each
   * side, except where the view already sits at the window's edge (moving could not show more there).
   */
  const inView = (v: View, rect: Shot["rect"]): boolean => {
    const [x, y, w, h] = viewRect(v, layout);
    const d = IN_VIEW_INSET * w;
    const l = x <= bx + 0.5 ? 0 : d;
    const t = y <= by + 0.5 ? 0 : d;
    const r = x + w >= bx + bw - 0.5 ? 0 : d;
    const b = y + h >= by + bh - 0.5 ? 0 : d;
    return contains([x + l, y + t, w - l - r, h - t - b], rect);
  };
  /** The widest in-between view (zoom below both ends) that both halves of a move can reach inside `window`. */
  const partialWide = (from: View, to: View, window: number): View | undefined => {
    const top = Math.min(from.zoom, to.zoom);
    for (let zm = 1.05; zm < top; zm *= 1.05) {
      const m = midView(from, to, zm);
      if (move(from, m) + move(m, to) <= window) return m;
    }
    return undefined;
  };
  const weight = (s: PathShot) => (s.source === "cue" ? Number.POSITIVE_INFINITY : weightOf(s));
  const arriveByOf = (s: Shot) => Math.max(0, s.start - p.anticipation);
  const deadline = (s: Shot) => s.end + p.minHold;
  /** The latest the camera may arrive somewhere and still respect the end of the video. */
  const lastArrival = (v: View) => (loop ? duration - move(v, wide) : duration);

  let cur: View = wide;
  let started = false; // has the opening keyframe been pushed?
  let free = 0; // earliest the camera may leave its current view
  let prevEnd = 0; // end of the last shot: idle time is counted from here
  let on: PathShot | undefined; // the shot the camera is on
  let onArrived = 0;

  shots.forEach((s, i) => {
    const isCue = s.source === "cue";
    const overlaps = on !== undefined && s.start < on.end;
    if (!isCue && on && overlaps && weight(s) <= weight(on)) return; // overshadowed by the current shot
    // A more salient shot (or a cue) during the current one may cut its hold down to minHold.
    const leaveAt = overlaps ? Math.min(free, onArrived + p.minHold) : free;
    const arriveBy = arriveByOf(s);
    const idleLeave = Math.max(leaveAt, prevEnd + p.idleWide);
    // Stay if visible (R-b): while zoomed in, an auto shot whose target is already in view, and whose own zoom is
    // within panZoomTolerance of the current one, keeps the current view and only extends the hold. A cue may still
    // re-frame; a wide camera (or a near-wide one, which would otherwise hold every later change "in view") still
    // zooms in; and when the camera has time to drift wide first, it comes back to the shot's own framing.
    const stays =
      !isCue &&
      cur.zoom > 1 + 1e-6 &&
      s.view.zoom <= cur.zoom * (1 + p.panZoomTolerance) &&
      inView(cur, s.rect) &&
      idleLeave + move(cur, wide) + move(wide, s.view) > arriveBy;
    const target = stays ? cur : s.view;
    // Non-loop: a first shot the camera cannot reach from wide in time opens the video already framed.
    const opens = !started && !loop && arriveBy < move(wide, target);
    const arrive =
      opens || same(cur, target)
        ? Math.max(leaveAt, opens ? 0 : arriveBy)
        : Math.max(arriveBy, leaveAt + move(cur, target));
    if (!isCue) {
      if (arrive > deadline(s) || arrive > lastArrival(target)) return; // stale, or no time left
      for (const n of shots.slice(i + 1)) {
        if (weight(n) <= weight(s)) continue;
        const depart = n.start < s.end ? arrive + p.minHold : Math.max(s.end, arrive + p.minHold);
        const viaS = Math.max(arriveByOf(n), depart + move(target, n.view));
        if (viaS <= deadline(n)) continue;
        const withoutS = Math.max(arriveByOf(n), free + move(cur, n.view));
        if (withoutS <= deadline(n)) return; // visiting s would lose a more salient shot
      }
    }
    if (!started) {
      started = true;
      if (opens) cur = target;
      push(0, cur);
    }
    free = leaveAt;
    const window = arriveBy - free;
    const outD = move(cur, wide);
    const inD = move(wide, target);
    const idleFits = idleLeave + outD + inD <= arriveBy;
    if (same(cur, target)) {
      if (!same(cur, wide) && idleFits) {
        via(cur, idleLeave, wide, arriveBy, target);
        free = Math.max(s.end, arriveBy + p.minHold);
        onArrived = arriveBy;
      } else free = Math.max(free, s.end);
      on = s;
      prevEnd = Math.max(prevEnd, s.end);
      return;
    }
    const direct = move(cur, target);
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
    on = s;
    onArrived = arrived;
    free = Math.max(s.end, arrived + p.minHold);
    prevEnd = Math.max(prevEnd, s.end);
  });

  if (!started) push(0, cur);
  const back = move(cur, wide);
  if (!same(cur, wide)) {
    const lastT = (kfs[kfs.length - 1] as Keyframe).t;
    const drift = Math.max(free, prevEnd + p.idleWide);
    if (loop) {
      // Drift wide after idleWide, or at the latest leave with the whole capped move back to wide still ahead:
      // the hold is cut short, never the move.
      const leave = Math.max(lastT, Math.min(drift, duration - back));
      push(leave, cur);
      push(leave + back, wide);
      cur = wide;
    } else {
      if (drift + back <= duration) {
        push(drift, cur);
        push(drift + back, wide);
        cur = wide;
      }
    }
  }
  push(duration, cur);
  return kfs;
}
