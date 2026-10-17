import { probe, readFrames, requireFfmpeg } from "../ffmpeg.js";
import type { Change, ChangesFile, Rect } from "../schema.js";
import { filterBlinks } from "./blink.js";
import { diffMask, findRegions, zeroRects } from "./diff.js";

export const ANALYSIS_FPS = 15;

export interface DetectOptions {
  /** Areas to ignore, in master pixels. */
  masks?: Rect[];
  /** Grayscale change (0–255) a pixel must exceed to count. Default 12. */
  threshold?: number;
  analysisFps?: number;
  /** Downscale divisor for analysis. Default 8. */
  scale?: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Where and when the picture changes, in master pixels and seconds. */
export async function detect(masterPath: string, opts: DetectOptions = {}): Promise<ChangesFile> {
  requireFfmpeg();
  const master = probe(masterPath);
  const fps = opts.analysisFps ?? ANALYSIS_FPS;
  const div = opts.scale ?? 8;
  const w = Math.max(2, Math.round(master.width / div / 2) * 2);
  const h = Math.max(2, Math.round(master.height / div / 2) * 2);
  const sx = master.width / w;
  const sy = master.height / h;
  const masks = (opts.masks ?? []).map(
    ([x, y, mw, mh]): Rect => [Math.floor(x / sx), Math.floor(y / sy), Math.ceil(mw / sx) + 1, Math.ceil(mh / sy) + 1],
  );
  const mergeDist = Math.max(1, Math.round(w * 0.02));
  const minCount = Math.max(1, Math.round(w * h * 0.0002));
  const threshold = opts.threshold ?? 12;
  const changes: Change[] = [];
  let prev: Uint8Array | null = null;
  await readFrames(
    ["-i", masterPath, "-an", "-vf", `fps=${fps},scale=${w}:${h}:flags=area,format=gray`, "-pix_fmt", "gray"],
    w * h,
    (frame, index) => {
      const cur = new Uint8Array(frame); // a copy: the frame buffer is reused
      if (prev) {
        const mask = diffMask(prev, cur, threshold);
        zeroRects(mask, w, h, masks);
        const regions = findRegions(mask, w, h, mergeDist, minCount);
        const t = round(index / fps);
        const covered = regions.reduce((sum, r) => sum + r.rect[2] * r.rect[3], 0);
        if (covered >= 0.6 * w * h) {
          changes.push({ t, rect: [0, 0, master.width, master.height], strength: 1, fullFrame: true });
        } else {
          for (const r of regions) {
            const [x, y, rw, rh] = r.rect;
            changes.push({
              t,
              rect: [Math.round(x * sx), Math.round(y * sy), Math.round(rw * sx), Math.round(rh * sy)],
              strength: round(Math.min(1, r.count / (rw * rh))),
            });
          }
        }
      }
      prev = cur;
    },
  );
  return { version: 1, master, changes: filterBlinks(changes) };
}
