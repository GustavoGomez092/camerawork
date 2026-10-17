import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { ANALYSIS_FPS, detect } from "../detect/index.js";
import { CameraworkError, parseWith } from "../errors.js";
import { probe, requireFfmpeg } from "../ffmpeg.js";
import { sceneLayout } from "../geometry.js";
import { resolveLook } from "../looks.js";
import {
  type ChangesFile,
  ChangesFileSchema,
  type CueFile,
  CueFileSchema,
  DEFAULT_PLANNER,
  type Look,
  OutputSchema,
  type OutputSettings,
  type Plan,
  type PlannerParams,
  PlannerParamsSchema,
  PlanSchema,
  type Rect,
} from "../schema.js";
import { toEvents, validateCues } from "./cues.js";
import { buildKeyframes } from "./path.js";
import { clusterShots, plainShot } from "./shots.js";

export interface PlanOptions {
  cues?: CueFile;
  changes?: ChangesFile;
  look?: string | Look;
  loop?: boolean;
  output?: Partial<OutputSettings>;
  planner?: Partial<PlannerParams>;
  masks?: Rect[];
}

export function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CameraworkError(`cannot read ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CameraworkError(`${path} is not valid JSON`);
  }
}

/** Writes JSON to a temporary file and renames it into place. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

export const readPlan = (path: string): Plan => parseWith(PlanSchema, readJson(path), path);
export const readCueFile = (path: string): CueFile => parseWith(CueFileSchema, readJson(path), path) as CueFile;
export const readChangesFile = (path: string): ChangesFile =>
  parseWith(ChangesFileSchema, readJson(path), path) as ChangesFile;

const floorEven = (n: number) => Math.floor(n / 2) * 2;

/** Detects (unless given changes), merges cues, and plans the camera. */
export async function plan(masterPath: string, opts: PlanOptions = {}): Promise<Plan> {
  requireFfmpeg();
  const master = probe(masterPath);
  if (opts.cues) validateCues(opts.cues, master);
  const look = resolveLook(opts.look ?? "hero");
  const output = parseWith(
    OutputSchema,
    {
      width: 1920,
      fps: 30,
      formats: ["mp4", "webm"],
      poster: "jpg",
      maxBytes: null,
      aspect: master.width / master.height,
      quality: "medium",
      ...opts.output,
    },
    "output settings",
  );
  const planner = parseWith(
    PlannerParamsSchema,
    { ...DEFAULT_PLANNER, ...opts.cues?.planner, ...opts.planner },
    "planner settings",
  );
  const layout = sceneLayout(master, look, output.aspect);
  const limit = layout.sceneW / output.width;
  if (limit < 1)
    throw new CameraworkError(
      `the scene is ${layout.sceneW} px wide but the output is ${output.width} px, which would upscale. ` +
        `Use --width ${floorEven(layout.sceneW)} or less, or record a bigger master.`,
    );
  const maxZoom = Math.min(planner.maxZoom, limit);
  if (opts.changes && (opts.changes.master.width !== master.width || opts.changes.master.height !== master.height))
    throw new CameraworkError(
      `the changes file was made from a ${opts.changes.master.width}x${opts.changes.master.height} video, ` +
        `not this ${master.width}x${master.height} one`,
    );
  const changes =
    opts.changes ?? (await detect(masterPath, { masks: [...(opts.masks ?? []), ...(opts.cues?.masks ?? [])] }));
  const events = toEvents(changes.changes, opts.cues, planner.minHold, 1 / ANALYSIS_FPS);
  const effective = { ...planner, maxZoom };
  const shots = clusterShots(events, layout, effective);
  const keyframes = buildKeyframes(shots, layout, effective, master.duration, opts.loop ?? false);
  return {
    version: 1,
    master,
    output,
    look,
    planner,
    maxZoom,
    loop: opts.loop ?? false,
    scene: { width: layout.sceneW, height: layout.sceneH },
    shots: shots.map(plainShot),
    keyframes,
  };
}
