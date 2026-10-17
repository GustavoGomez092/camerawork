import { mapRect, type SceneLayout } from "../geometry.js";
import type { PlannerParams, Rect, Shot } from "../schema.js";
import type { PlanEvent } from "./cues.js";
import { frameRect, unionRect, wideView } from "./framing.js";

/**
 * Groups events into shots. An auto event joins the current auto shot when it starts within `shotJoinGap` of the
 * shot's end and the union still frames within `panZoomTolerance` of the shot's zoom (so a typing burst becomes one
 * growing shot). Cues and wide events are always their own shot.
 */
export function clusterShots(events: PlanEvent[], layout: SceneLayout, p: PlannerParams): Shot[] {
  const shots: (Shot & { wide: boolean })[] = [];
  const whole: Rect = [0, 0, layout.sceneW, layout.sceneH];
  for (const e of events) {
    const wide = e.wide === true;
    const rect = wide ? whole : mapRect(layout, e.rect);
    const view = wide ? wideView(layout) : frameRect(rect, layout, p.margin, p.maxZoom, e.zoom);
    const cur = shots[shots.length - 1];
    if (
      cur &&
      !wide &&
      !cur.wide &&
      e.source === "auto" &&
      cur.source === "auto" &&
      e.start <= cur.end + p.shotJoinGap
    ) {
      const merged = unionRect(cur.rect, rect);
      const mergedView = frameRect(merged, layout, p.margin, p.maxZoom);
      if (mergedView.zoom >= cur.view.zoom / (1 + p.panZoomTolerance)) {
        cur.rect = merged;
        cur.view = mergedView;
        cur.end = Math.max(cur.end, e.end);
        continue;
      }
    }
    shots.push({ start: e.start, end: e.end, rect, view, source: e.source, wide });
  }
  return shots.map(({ wide: _wide, ...shot }) => shot);
}
