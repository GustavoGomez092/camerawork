import { mapRect, type SceneLayout } from "../geometry.js";
import type { PlannerParams, Rect, Shot } from "../schema.js";
import type { PlanEvent } from "./cues.js";
import { frameRect, unionRect, viewRect, wideView } from "./framing.js";

/** A shot plus how much changed in it (changed master pixels; Infinity for cues). Planning-internal. */
export type WeightedShot = Shot & { weight: number };

interface Item extends WeightedShot {
  wide: boolean;
}

/** Changed pixels of an event; without a measured weight, the whole rectangle counts. */
export const weightOf = (e: { weight?: number; rect: Rect }): number => e.weight ?? e.rect[2] * e.rect[3];

/** Drops the planning-internal weight, leaving what the plan file stores. */
export const plainShot = ({ weight: _weight, ...shot }: WeightedShot): Shot => shot;

/** Is `inner` entirely inside `outer`? */
export const contains = ([x, y, w, h]: Rect, [ix, iy, iw, ih]: Rect): boolean =>
  ix >= x && iy >= y && ix + iw <= x + w && iy + ih <= y + h;

/**
 * One moment's auto events (one UI update, possibly touching several far-apart places) reduced to what matters:
 * regions are taken heaviest first; a region joins a group only when it lies entirely inside the view framing the
 * group's first (dominant) region, and otherwise starts its own group. The group with the most changed pixels wins
 * and the rest is dropped. The shot is framed on the winning group's dominant region alone, so a secondary change
 * never drags the camera off-centre (R-a); its members only add weight and stretch the moment's time span.
 */
function dominant(moment: PlanEvent[], layout: SceneLayout, p: PlannerParams): Item {
  const regions = moment
    .map((e) => ({ e, rect: mapRect(layout, e.rect), weight: weightOf(e) }))
    .sort((a, b) => b.weight - a.weight);
  const groups: { rect: Rect; seen: Rect; weight: number; start: number; end: number }[] = [];
  for (const r of regions) {
    const group = groups.find((g) => contains(g.seen, r.rect));
    if (group) {
      group.weight += r.weight;
      group.start = Math.min(group.start, r.e.start);
      group.end = Math.max(group.end, r.e.end);
    } else {
      const seen = viewRect(frameRect(r.rect, layout, p.margin, p.maxZoom), layout);
      groups.push({ rect: r.rect, seen, weight: r.weight, start: r.e.start, end: r.e.end });
    }
  }
  const best = groups.reduce((a, b) => (b.weight > a.weight ? b : a));
  return {
    start: best.start,
    end: best.end,
    rect: best.rect,
    view: frameRect(best.rect, layout, p.margin, p.maxZoom),
    source: "auto",
    weight: best.weight,
    wide: false,
  };
}

/**
 * Groups events into shots. Auto events are first consolidated per moment (events starting within `shotJoinGap` of
 * the moment's first): only the most salient place survives, and the shot is framed on it (see `dominant`). This supersedes the literal spec §5.2
 * join rule, which let one UI update touching the toolbar, a tab title and the status bar become a camera tour.
 * A moment's shot then joins the current auto shot when it starts within `shotJoinGap` of the shot's end, its region
 * lies inside the shot's current view (the next glyph lands in the margin around the text so far), and the union still
 * frames within `panZoomTolerance` of the shot's zoom: a typing burst becomes one growing shot, while a change
 * elsewhere (typing in an editor after an output panel updated) stays its own shot (R-a).
 * Cues and wide events are never dropped or merged: each is its own shot.
 */
export function clusterShots(events: PlanEvent[], layout: SceneLayout, p: PlannerParams): WeightedShot[] {
  const whole: Rect = [0, 0, layout.sceneW, layout.sceneH];
  const items: Item[] = [];
  const autos: PlanEvent[] = [];
  for (const e of events) {
    if (e.source === "auto" && !e.wide) {
      autos.push(e);
      continue;
    }
    const wide = e.wide === true;
    const rect = wide ? whole : mapRect(layout, e.rect);
    const view = wide ? wideView(layout) : frameRect(rect, layout, p.margin, p.maxZoom, e.zoom);
    const weight = e.source === "cue" ? Number.POSITIVE_INFINITY : weightOf(e);
    items.push({ start: e.start, end: e.end, rect, view, source: e.source, weight, wide });
  }
  autos.sort((a, b) => a.start - b.start);
  for (let i = 0; i < autos.length; ) {
    const from = (autos[i] as PlanEvent).start;
    let j = i;
    while (j < autos.length && (autos[j] as PlanEvent).start < from + p.shotJoinGap) j++;
    items.push(dominant(autos.slice(i, j), layout, p));
    i = j;
  }
  items.sort((a, b) => a.start - b.start);

  const shots: Item[] = [];
  for (const it of items) {
    const cur = shots[shots.length - 1];
    if (
      cur &&
      !it.wide &&
      !cur.wide &&
      it.source === "auto" &&
      cur.source === "auto" &&
      it.start <= cur.end + p.shotJoinGap &&
      contains(viewRect(cur.view, layout), it.rect)
    ) {
      const merged = unionRect(cur.rect, it.rect);
      const mergedView = frameRect(merged, layout, p.margin, p.maxZoom);
      if (mergedView.zoom >= cur.view.zoom / (1 + p.panZoomTolerance)) {
        cur.rect = merged;
        cur.view = mergedView;
        cur.end = Math.max(cur.end, it.end);
        cur.weight += it.weight;
        continue;
      }
    }
    shots.push({ ...it });
  }
  return shots.map(({ wide: _wide, ...shot }) => shot);
}
