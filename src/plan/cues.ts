import { CameraworkError } from "../errors.js";
import type { Change, CueFile, Probe, Rect } from "../schema.js";

/** A moment the camera may want to look at. `rect` is in master pixels. */
export interface PlanEvent {
  start: number;
  end: number;
  rect: Rect;
  source: "auto" | "cue";
  zoom?: number;
  wide?: boolean;
  /** Changed pixels (master pixels): how much happened. Auto events only; cues outrank everything. */
  weight?: number;
}

const after = (what: string, v: number, master: Probe) =>
  new CameraworkError(`${what}=${v} is after the end of the video (${master.duration.toFixed(2)} s)`);

/** Checks cue times and rectangles against the video; each error names the cue by index and label. */
export function validateCues(file: CueFile, master: Probe): void {
  file.cues.forEach((cue, i) => {
    const where = `cue ${i}${cue.label ? ` ("${cue.label}")` : ""}`;
    if ("ignore" in cue) {
      if (cue.from >= cue.to) throw new CameraworkError(`${where}: "from" must be before "to"`);
      if (cue.from > master.duration) throw after(`${where}: from`, cue.from, master);
      return;
    }
    if (cue.t > master.duration) throw after(`${where}: t`, cue.t, master);
    if ("rect" in cue) {
      const [x, y, w, h] = cue.rect;
      if (x < 0 || y < 0 || x + w > master.width || y + h > master.height)
        throw new CameraworkError(
          `${where}: rect ${JSON.stringify(cue.rect)} is outside the ${master.width}x${master.height} video`,
        );
    }
  });
}

/** Merges detected changes with cues: a cue's window and every ignore range discard detected changes inside them. */
export function toEvents(
  changes: Change[],
  cues: CueFile | undefined,
  minHold: number,
  frameStep: number,
): PlanEvent[] {
  const windows: [number, number][] = [];
  const events: PlanEvent[] = [];
  for (const cue of cues?.cues ?? []) {
    if ("ignore" in cue) {
      windows.push([cue.from, cue.to]);
      continue;
    }
    if ("poster" in cue) continue;
    if ("wide" in cue) {
      const end = cue.t + minHold;
      windows.push([cue.t, end]);
      events.push({ start: cue.t, end, rect: [0, 0, 1, 1], source: "cue", wide: true });
      continue;
    }
    const end = cue.t + (cue.hold ?? minHold);
    windows.push([cue.t, end]);
    events.push({ start: cue.t, end, rect: cue.rect, source: "cue", ...(cue.zoom ? { zoom: cue.zoom } : {}) });
  }
  for (const c of changes) {
    if (windows.some(([a, b]) => c.t >= a && c.t <= b)) continue;
    events.push({
      start: c.t,
      end: c.t + frameStep,
      rect: c.rect,
      source: "auto",
      weight: c.strength * c.rect[2] * c.rect[3],
      ...(c.fullFrame ? { wide: true } : {}),
    });
  }
  return events.sort((a, b) => a.start - b.start);
}
