import { z } from "zod";

export const RectSchema = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]);
export type Rect = [number, number, number, number];

export const ProbeSchema = z
  .object({
    path: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    duration: z.number().positive(),
  })
  .strict();
export type Probe = z.infer<typeof ProbeSchema>;

export const ChangeSchema = z
  .object({
    t: z.number().nonnegative(),
    rect: RectSchema,
    strength: z.number().min(0).max(1),
    fullFrame: z.boolean().optional(),
  })
  .strict();
export type Change = { t: number; rect: Rect; strength: number; fullFrame?: boolean };

export const ChangesFileSchema = z
  .object({ version: z.literal(1), master: ProbeSchema, changes: z.array(ChangeSchema) })
  .strict();
export type ChangesFile = { version: 1; master: Probe; changes: Change[] };

export const PlannerParamsSchema = z
  .object({
    margin: z.number().min(0).max(1),
    maxZoom: z.number().min(1),
    panZoomTolerance: z.number().min(0),
    zoomOutGap: z.number().min(0),
    anticipation: z.number().min(0),
    minHold: z.number().min(0),
    maxPanSpeed: z.number().positive(),
    maxZoomRate: z.number().gt(1),
    idleWide: z.number().positive(),
    shotJoinGap: z.number().min(0),
  })
  .strict();
export type PlannerParams = z.infer<typeof PlannerParamsSchema>;

export const DEFAULT_PLANNER: PlannerParams = {
  margin: 0.12,
  maxZoom: 2.2,
  panZoomTolerance: 0.3,
  zoomOutGap: 1.0,
  anticipation: 0.35,
  minHold: 1.2,
  maxPanSpeed: 0.6,
  maxZoomRate: 1.5,
  idleWide: 2.5,
  shotJoinGap: 0.6,
};

const label = z.string().optional();
const FocusCueSchema = z
  .object({
    t: z.number().nonnegative(),
    rect: RectSchema,
    zoom: z.number().min(1).optional(),
    hold: z.number().positive().optional(),
    label,
  })
  .strict();
const WideCueSchema = z.object({ t: z.number().nonnegative(), wide: z.literal(true), label }).strict();
const IgnoreCueSchema = z
  .object({ from: z.number().nonnegative(), to: z.number().positive(), ignore: z.literal(true), label })
  .strict();
export const CueSchema = z.union([FocusCueSchema, WideCueSchema, IgnoreCueSchema]);
export type FocusCue = { t: number; rect: Rect; zoom?: number; hold?: number; label?: string };
export type WideCue = { t: number; wide: true; label?: string };
export type IgnoreCue = { from: number; to: number; ignore: true; label?: string };
export type Cue = FocusCue | WideCue | IgnoreCue;

export const CueFileSchema = z
  .object({
    version: z.literal(1),
    masks: z.array(RectSchema).optional(),
    planner: PlannerParamsSchema.partial().optional(),
    cues: z.array(CueSchema),
  })
  .strict();
export type CueFile = { version: 1; masks?: Rect[]; planner?: Partial<PlannerParams>; cues: Cue[] };

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb");
export const BackdropSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("gradient"),
      stops: z.array(z.object({ at: z.number().min(0).max(1), color }).strict()).min(2),
      angle: z.number(),
    })
    .strict(),
  z.object({ type: z.literal("solid"), color }).strict(),
  z.object({ type: z.literal("image"), path: z.string().min(1) }).strict(),
  z.object({ type: z.literal("none") }).strict(),
]);
export type Backdrop = z.infer<typeof BackdropSchema>;

export const LookSchema = z
  .object({
    preset: z.string().optional(),
    backdrop: BackdropSchema,
    padding: z.number().min(0).max(0.45),
    radius: z.number().min(0),
    shadow: z.object({ blur: z.number().min(0), offsetY: z.number(), opacity: z.number().min(0).max(1) }).strict(),
    tilt: z
      .object({
        rotateX: z.number().min(-30).max(30),
        rotateY: z.number().min(-30).max(30),
        perspective: z.number().positive(),
      })
      .strict(),
  })
  .strict();
export type Look = z.infer<typeof LookSchema>;

export const OutputSchema = z
  .object({
    width: z
      .number()
      .int()
      .positive()
      .refine((w) => w % 2 === 0, "must be even"),
    fps: z.number().positive(),
    formats: z.array(z.enum(["mp4", "webm"])).min(1),
    poster: z.enum(["jpg", "webp"]).nullable(),
    maxBytes: z.number().int().positive().nullable(),
    aspect: z.number().positive(),
    quality: z.enum(["medium", "high"]),
  })
  .strict();
export type OutputSettings = z.infer<typeof OutputSchema>;

export const ViewSchema = z.object({ cx: z.number(), cy: z.number(), zoom: z.number().min(1) }).strict();
export type View = z.infer<typeof ViewSchema>;
export const KeyframeSchema = z
  .object({ t: z.number().nonnegative(), cx: z.number(), cy: z.number(), zoom: z.number().min(1) })
  .strict();
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const ShotSchema = z
  .object({
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    rect: RectSchema,
    view: ViewSchema,
    source: z.enum(["auto", "cue"]),
  })
  .strict();
export type Shot = { start: number; end: number; rect: Rect; view: View; source: "auto" | "cue" };

export const PlanSchema = z
  .object({
    version: z.literal(1),
    master: ProbeSchema,
    output: OutputSchema,
    look: LookSchema,
    planner: PlannerParamsSchema,
    maxZoom: z.number().min(1),
    loop: z.boolean(),
    scene: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
    shots: z.array(ShotSchema),
    keyframes: z
      .array(KeyframeSchema)
      .min(1)
      .refine((k) => k.every((f, i) => i === 0 || f.t >= (k[i - 1] as Keyframe).t), "keyframes must be in time order"),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;
