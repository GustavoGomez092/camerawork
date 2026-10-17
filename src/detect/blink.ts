import type { Change, Rect } from "../schema.js";

export function iou(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

export interface BlinkOptions {
  minPeriod: number;
  maxPeriod: number;
  minRepeats: number;
  iou: number;
  jitter: number;
}

export const DEFAULT_BLINK: BlinkOptions = { minPeriod: 0.3, maxPeriod: 1.5, minRepeats: 3, iou: 0.6, jitter: 0.25 };

/** Splits one place's changes where it paused for longer than a blink period (a cursor hidden while a palette is open). */
function splitRuns(g: Change[], opts: BlinkOptions): Change[][] {
  const runs: Change[][] = [[g[0] as Change]];
  for (let i = 1; i < g.length; i++) {
    const c = g[i] as Change;
    if (c.t - (g[i - 1] as Change).t > opts.maxPeriod * (1 + opts.jitter)) runs.push([c]);
    else (runs[runs.length - 1] as Change[]).push(c);
  }
  return runs;
}

/** At least `minRepeats` changes at a steady period between `minPeriod` and `maxPeriod`. */
function isSteady(run: Change[], opts: BlinkOptions): boolean {
  if (run.length < opts.minRepeats) return false;
  const gaps = run.slice(1).map((c, i) => c.t - (run[i] as Change).t);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  if (median < opts.minPeriod || median > opts.maxPeriod) return false;
  return gaps.every((x) => Math.abs(x - median) <= median * opts.jitter);
}

/**
 * Drops changes that repeat in one place at a steady rhythm (a text cursor, a spinner). Once a place blinks steadily
 * anywhere in the video, every change there is a blink, including lone ones before or after a pause.
 */
export function filterBlinks(changes: Change[], opts: BlinkOptions = DEFAULT_BLINK): Change[] {
  const groups: Change[][] = [];
  for (const c of changes) {
    if (c.fullFrame) continue;
    const group = groups.find((g) => iou((g[g.length - 1] as Change).rect, c.rect) >= opts.iou);
    if (group) group.push(c);
    else groups.push([c]);
  }
  const blinks = new Set<Change>();
  for (const g of groups) if (splitRuns(g, opts).some((run) => isSteady(run, opts))) for (const c of g) blinks.add(c);
  return changes.filter((c) => !blinks.has(c));
}
