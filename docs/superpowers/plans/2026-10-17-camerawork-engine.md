# camerawork Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A publish-ready npm package and CLI, `camerawork`, that turns a high-resolution screen recording into a guided video tour (automatic zoom and pan to what changes, optional script cues, a presentation look), plus a Claude skill that drives it.

**Architecture:** Five stages over plain JSON files: `detect` (ffmpeg grayscale frames → frame differencing → change rectangles) → `plan` (changes + cues → shots → camera keyframes, written to `plan.json`) → `preview` (contact sheet + debug video) → `render` (ffmpeg builds the scene with the look → Skia applies the camera per frame → ffmpeg encodes mp4/webm/poster). Every algorithm is a pure, unit-tested function; ffmpeg and Skia sit behind thin adapters.

**Tech Stack:** TypeScript (ESM, `nodenext`), Node ≥ 20 and Bun ≥ 1.4, `@napi-rs/canvas` 1.0.11 (Skia), `zod` 4, ffmpeg/ffprobe ≥ 6 on PATH (not bundled), `bun test`, Biome 2, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-17-camerawork-design.md`

## Global Constraints

- License MIT. Runtime dependencies: **only** `@napi-rs/canvas` and `zod`. ffmpeg/ffprobe are required on PATH and never bundled.
- Source under `src/` uses only `node:` built-ins plus the two dependencies — **no Bun APIs** in `src/` (the package must run on Node ≥ 20). Tests may use `bun:test`.
- ESM with explicit `.js` extensions on relative imports (`import { x } from "./schema.js"`).
- All coordinates are master pixels (or scene pixels where named), origin top-left; rectangles are `[x, y, w, h]`. Times are seconds from the master's first frame.
- `plan.json` is the source of truth for rendering; `render` never re-detects.
- No silent upscaling: output width × zoom must never exceed the scene width.
- Output files are written to a temporary name and renamed only on success.
- Every user-facing error is a `CameraworkError` whose message says what to change; the CLI prints `camerawork: <message>` and exits 1.
- Default planner values (spec §5.3): `margin` 0.12, `maxZoom` 2.2, `panZoomTolerance` 0.3, `zoomOutGap` 1.0, `anticipation` 0.35, `minHold` 1.2, `maxPanSpeed` 0.6, `maxZoomRate` 1.5, `idleWide` 2.5, `shotJoinGap` 0.6.
- Detection defaults (spec §4): analysis 15 fps at 1/8 size, threshold 12/255, merge distance 2 % of width, minimum area 0.02 % of frame, full-frame at ≥ 60 % coverage; blink period 0.3–1.5 s, ≥ 3 repeats, IoU ≥ 0.6.
- Encodes (spec §6.2): mp4 `libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart`; webm `libsvtav1 -crf 32 -preset 6`, else `libvpx-vp9 -crf 32 -b:v 0 -row-mt 1`.
- Look lengths (`radius`, `shadow.blur`, `shadow.offsetY`, `tilt.perspective`) are pixels **at a 1920-px-wide window** and scale with the actual window width (ruling R1).
- Lint: `bunx biome check .` reports no errors. Tests: `bun test`.

## Rulings made while planning (refinements of the spec)

- **R1 — look units.** The spec gives look lengths without units. They are defined at a 1920-px-wide window and scaled by `windowWidth / 1920`, so one preset looks the same on a 1080p or a 4K master.
- **R2 — the `hero` preset, measured.** From the JSLab hero (`hero-short.mp4` at 33.5 s, 1920×1080): window at x 172–1747, y 97–982 → **padding 0.09**; edges exactly vertical/horizontal → **no tilt**; corner radius ≈ 14 px on a 1576-px window → **radius 18** at 1920. Its backdrop is a grayscale dune photo from openvid (the hero was made in openvid: `assets/video/OpenVid/`), which camerawork cannot ship (PolyForm Noncommercial). The preset uses a gradient matching the sampled colors instead: #8f8f8f at 0, #c4c4c4 at 0.27, #1a1a1a at 0.42, #0e0e0e at 1. Users can pass their own backdrop image. Tilt remains a supported look input; `hero` just doesn't use it.
- **R3 — gradient stops** are `{ at, color }` objects (a bare color list cannot express the hero's horizon).
- **R4 — smoothing quality.** Skia "high" costs 49 ms per 4K→2560 frame vs 19 ms for "medium" (bilinear + mipmaps, right for downscaling), measured 2026-10-17. Default `medium`; `--quality high` available.
- **R5 — sharpness at plan time.** `plan` caps `maxZoom` at `sceneWidth / outputWidth` and records the effective value as `plan.maxZoom`; `render` re-checks so a hand-edited plan cannot upscale. "No silent upscaling" holds without failing a default run.
- **R6 — default output:** width 1920, fps 30, formats mp4+webm, poster jpg, aspect = the master's, quality medium.
- **R7 — warping alpha.** ffmpeg's `perspective` filter copies edge pixels into uncovered areas and does not carry alpha. The rounded mask is padded with an 8-px black border before warping (verified 2026-10-17), and only the color video is warped per frame; the mask also hides that border whenever the window sits on a backdrop.

## Review Focus

1. **Variable-frame-rate or 60 fps masters** (macOS `screencapture` writes VFR `.mov`): every ffmpeg read normalizes with an `fps=` filter, so frame index ↔ time is exact. Test: Task 6 detects on a 60 fps input.
2. **Odd master dimensions** (e.g. 1365×767): the scene and the output are forced even (yuv420p). Test: Task 4 `sceneLayout` with an odd master.
3. **A master in which nothing changes:** `plan` yields a single wide hold and `render` still produces a valid video. Test: Task 9 "no shots" and Task 10 "no changes".
4. **A change at t ≈ 0 or in the last second:** anticipation never produces negative times; keyframes never pass the duration. Test: Task 9 "shot at t=0.1" and "shot near the end".
5. **Paths with spaces** (`/Volumes/Content/projects/JSLab Website/…`): every process is spawned with an argv array, never a shell. Test: the temp dirs from `tmpDir()` always contain a space (Task 3 helper), and Task 12's end-to-end test names files with spaces.

---

## File structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `bunfig.toml`, `.github/workflows/ci.yml` | Package, build, lint, CI |
| `src/errors.ts` | `CameraworkError`, `parseWith` (zod → readable error) |
| `src/schema.ts` | Zod schemas, types and `DEFAULT_PLANNER` for every file format |
| `src/looks.ts` | Built-in looks (`hero`, `flat`) and `resolveLook` |
| `src/ffmpeg.ts` | `requireFfmpeg`, `probe`, `hasEncoder`, `runFfmpeg`, `readFrames`, `FrameSink` |
| `src/geometry.ts` | `tiltQuad`, `homography`, `applyH`, `sceneLayout`, `masterToScene`, `mapRect` |
| `src/detect/diff.ts` | `diffMask`, `zeroRects`, `findRegions` |
| `src/detect/blink.ts` | `iou`, `filterBlinks` |
| `src/detect/index.ts` | `detect()` |
| `src/plan/cues.ts` | `validateCues`, `toEvents` |
| `src/plan/framing.ts` | `wideView`, `frameRect`, `unionRect` |
| `src/plan/shots.ts` | `clusterShots` |
| `src/plan/interp.ts` | `easeInOutCubic`, `cameraAt` |
| `src/plan/path.ts` | `moveDuration`, `buildKeyframes` |
| `src/plan/index.ts` | `plan()`, `readJson`, `writeJsonAtomic`, `readPlan`, `readCueFile`, `readChangesFile` |
| `src/render/assets.ts` | `makeLookAssets` (backdrop, warped mask, shadow PNGs) |
| `src/render/scene.ts` | `perspectiveExpr`, `sceneArgs` (ffmpeg scene graph argv) |
| `src/render/encode.ts` | `encoderArgs`, `pickWebmCodec` |
| `src/render/camera.ts` | `Camera` (Skia per-frame transform) |
| `src/render/index.ts` | `render()`, `checkSharpness()` |
| `src/preview.ts` | `preview()` |
| `src/cli.ts` | CLI entry (`bin`) |
| `src/index.ts` | Public API exports |
| `skills/camerawork/SKILL.md` | The Claude skill |
| `test/helpers.ts` | `makeBoxVideo` (synthetic test videos), `tmpDir` |
| `test/*.test.ts` | One test file per module |

---

### Task 1: Package scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `bunfig.toml`, `src/errors.ts`, `src/index.ts`, `test/errors.test.ts`, `.github/workflows/ci.yml`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `class CameraworkError extends Error`; `parseWith<T>(schema: z.ZodType<T>, data: unknown, what: string): T`.

- [ ] **Step 1: Write the package files**

`package.json`:
```json
{
  "name": "camerawork",
  "version": "0.1.0",
  "description": "Turn screen recordings into guided video tours: automatic zoom and pan to what changes, with a presentation look.",
  "license": "MIT",
  "type": "module",
  "repository": { "type": "git", "url": "git+https://github.com/GustavoGomez092/camerawork.git" },
  "keywords": ["screen recording", "video", "zoom", "demo", "ffmpeg", "product video"],
  "bin": { "camerawork": "dist/cli.js" },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "skills", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "lint": "biome check .",
    "prepublishOnly": "bun run lint && bun run typecheck && bun test && bun run build"
  },
  "dependencies": { "@napi-rs/canvas": "1.0.11", "zod": "^4.6.7" },
  "devDependencies": { "@biomejs/biome": "^2.5.15", "@types/bun": "^1.3.0", "@types/node": "^24.0.0", "typescript": "^7.0.2" }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "es2022", "module": "nodenext", "moduleResolution": "nodenext",
    "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": true,
    "declaration": true, "outDir": "dist", "rootDir": ".", "types": ["node", "bun"]
  },
  "include": ["src", "test"]
}
```

`tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "compilerOptions": { "rootDir": "src", "types": ["node"] }, "include": ["src"] }
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.15/schema.json",
  "files": { "includes": ["src/**", "test/**", "*.json"] },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 120 },
  "javascript": { "formatter": { "quoteStyle": "double" } },
  "linter": { "rules": { "recommended": true } }
}
```

`bunfig.toml`:
```toml
[test]
root = "./test"
timeout = 120000
```

Append `coverage/` to `.gitignore`.

- [ ] **Step 2: Install and verify the toolchain**

Run: `bun install && bunx tsc --version && bunx biome --version`
Expected: three version lines, TypeScript 7.x. If `typescript@7` fails to install or has no `tsc`, pin `"typescript": "^5.9.0"` and ledger the ruling.

- [ ] **Step 3: Write the failing test**

`test/errors.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CameraworkError, parseWith } from "../src/errors.js";

describe("parseWith", () => {
  const schema = z.object({ width: z.number().int().positive(), name: z.string() }).strict();

  test("returns the parsed value", () => {
    expect(parseWith(schema, { width: 4, name: "a" }, "thing")).toEqual({ width: 4, name: "a" });
  });

  test("throws a CameraworkError naming the file and every bad field", () => {
    try {
      parseWith(schema, { width: -1, extra: true }, "plan.json");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CameraworkError);
      const message = (error as Error).message;
      expect(message).toStartWith("plan.json is invalid: ");
      expect(message).toContain("width:");
      expect(message).toContain("name:");
    }
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun test test/errors.test.ts`
Expected: FAIL — cannot find module `../src/errors.js`.

- [ ] **Step 5: Implement**

`src/errors.ts`:
```ts
import type { z } from "zod";

/** An error meant for the person running camerawork: its message says what to change. */
export class CameraworkError extends Error {
  override name = "CameraworkError";
}

/** Validates `data` against `schema`, or throws one CameraworkError listing every invalid field. */
export function parseWith<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new CameraworkError(`${what} is invalid: ${problems.join("; ")}`);
}
```

`src/index.ts`:
```ts
export { CameraworkError } from "./errors.js";
```

- [ ] **Step 6: Run the test, lint and typecheck**

Run: `bun test test/errors.test.ts && bunx biome check . && bunx tsc --noEmit`
Expected: 2 pass; no lint errors; no type errors.

- [ ] **Step 7: Add CI**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    strategy:
      matrix: { os: [ubuntu-latest, macos-latest] }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.4.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: Install ffmpeg
        run: if [ "$RUNNER_OS" = "Linux" ]; then sudo apt-get update && sudo apt-get install -y ffmpeg; else brew install ffmpeg; fi
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun test
      - run: bun run build && node dist/cli.js --version
```

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "chore: package scaffold, errors module, CI"
```

---

### Task 2: Schemas and looks

**Files:**
- Create: `src/schema.ts`, `src/looks.ts`, `test/schema.test.ts`

**Interfaces:**
- Consumes: `parseWith`, `CameraworkError` (Task 1).
- Produces (all exported from `src/schema.ts`):
  - `type Rect = [number, number, number, number]`, `RectSchema`
  - `type Probe = { path: string; width: number; height: number; fps: number; duration: number }`, `ProbeSchema`
  - `type Change = { t: number; rect: Rect; strength: number; fullFrame?: boolean }`; `type ChangesFile = { version: 1; master: Probe; changes: Change[] }`, `ChangesFileSchema`
  - `type Cue = FocusCue | WideCue | IgnoreCue` with `FocusCue = { t; rect; zoom?; hold?; label? }`, `WideCue = { t; wide: true; label? }`, `IgnoreCue = { from; to; ignore: true; label? }`; `type CueFile = { version: 1; masks?: Rect[]; planner?: Partial<PlannerParams>; cues: Cue[] }`, `CueFileSchema`
  - `type PlannerParams = { margin; maxZoom; panZoomTolerance; zoomOutGap; anticipation; minHold; maxPanSpeed; maxZoomRate; idleWide; shotJoinGap }` (all numbers), `PlannerParamsSchema`, `DEFAULT_PLANNER`
  - `type Backdrop = { type: "gradient"; stops: { at: number; color: string }[]; angle: number } | { type: "solid"; color: string } | { type: "image"; path: string } | { type: "none" }`
  - `type Look = { preset?: string; backdrop: Backdrop; padding: number; radius: number; shadow: { blur; offsetY; opacity }; tilt: { rotateX; rotateY; perspective } }`, `LookSchema`
  - `type OutputSettings = { width: number; fps: number; formats: ("mp4" | "webm")[]; poster: "jpg" | "webp" | null; maxBytes: number | null; aspect: number; quality: "medium" | "high" }`, `OutputSchema`
  - `type View = { cx: number; cy: number; zoom: number }`, `type Keyframe = View & { t: number }`
  - `type Shot = { start: number; end: number; rect: Rect; view: View; source: "auto" | "cue" }`
  - `type Plan = { version: 1; master: Probe; output: OutputSettings; look: Look; planner: PlannerParams; maxZoom: number; loop: boolean; scene: { width: number; height: number }; shots: Shot[]; keyframes: Keyframe[] }`, `PlanSchema`
- Produces (`src/looks.ts`): `LOOKS` with keys `hero` and `flat`; `resolveLook(look: string | Look): Look`.

- [ ] **Step 1: Write the failing tests**

`test/schema.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { CameraworkError, parseWith } from "../src/errors.js";
import { LOOKS, resolveLook } from "../src/looks.js";
import { CueFileSchema, DEFAULT_PLANNER, LookSchema, PlanSchema, PlannerParamsSchema } from "../src/schema.js";

describe("cue files", () => {
  test("accept focus, wide and ignore cues, masks and planner overrides", () => {
    const file = {
      version: 1,
      masks: [[3700, 0, 140, 40]],
      planner: { maxZoom: 2 },
      cues: [
        { t: 3.2, rect: [1083, 26, 261, 57], zoom: 2, hold: 1.5, label: "filter chips" },
        { t: 8, wide: true },
        { from: 5, to: 6, ignore: true },
      ],
    };
    expect(parseWith(CueFileSchema, file, "cues.json").cues).toHaveLength(3);
  });

  test("reject unknown keys and a non-positive rect size", () => {
    expect(() => parseWith(CueFileSchema, { version: 1, cues: [{ t: 1, rect: [0, 0, 0, 5] }] }, "c")).toThrow(
      CameraworkError,
    );
    expect(() => parseWith(CueFileSchema, { version: 1, cues: [{ t: 1, wide: true, zoom: 2 }] }, "c")).toThrow(
      CameraworkError,
    );
  });
});

describe("planner defaults", () => {
  test("match the spec", () => {
    expect(DEFAULT_PLANNER).toEqual({
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
    });
    expect(PlannerParamsSchema.safeParse(DEFAULT_PLANNER).success).toBe(true);
  });
});

describe("looks", () => {
  test("both built-in looks are valid", () => {
    for (const look of Object.values(LOOKS)) expect(LookSchema.safeParse(look).success).toBe(true);
  });

  test("hero is the measured preset (ruling R2)", () => {
    expect(LOOKS.hero.padding).toBe(0.09);
    expect(LOOKS.hero.radius).toBe(18);
    expect(LOOKS.hero.tilt).toEqual({ rotateX: 0, rotateY: 0, perspective: 2400 });
  });

  test("resolveLook returns a copy of a preset, validates an object, and rejects unknown names", () => {
    const hero = resolveLook("hero");
    hero.padding = 0.2;
    expect(LOOKS.hero.padding).toBe(0.09);
    expect(resolveLook({ ...LOOKS.flat, padding: 0.05 }).padding).toBe(0.05);
    expect(() => resolveLook("sparkly")).toThrow('unknown look "sparkly" (known: hero, flat)');
    expect(() => resolveLook({ ...LOOKS.flat, padding: 0.6 })).toThrow(CameraworkError);
  });
});

describe("plans", () => {
  const plan = {
    version: 1,
    master: { path: "m.mov", width: 1280, height: 720, fps: 30, duration: 5 },
    output: { width: 640, fps: 30, formats: ["mp4"], poster: null, maxBytes: null, aspect: 16 / 9, quality: "medium" },
    look: LOOKS.flat,
    planner: DEFAULT_PLANNER,
    maxZoom: 2,
    loop: false,
    scene: { width: 1280, height: 720 },
    shots: [],
    keyframes: [
      { t: 0, cx: 640, cy: 360, zoom: 1 },
      { t: 5, cx: 640, cy: 360, zoom: 1 },
    ],
  };

  test("a valid plan parses", () => {
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });

  test("keyframes must be in time order and the output width even", () => {
    const shuffled = { ...plan, keyframes: [...plan.keyframes].reverse() };
    expect(PlanSchema.safeParse(shuffled).success).toBe(false);
    expect(PlanSchema.safeParse({ ...plan, output: { ...plan.output, width: 641 } }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/schema.test.ts`
Expected: FAIL — cannot find module `../src/looks.js`.

- [ ] **Step 3: Implement `src/schema.ts`**

```ts
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
      .refine(
        (k) => k.every((f, i) => i === 0 || f.t >= (k[i - 1] as Keyframe).t),
        "keyframes must be in time order",
      ),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;
```

- [ ] **Step 4: Implement `src/looks.ts`**

```ts
import { CameraworkError, parseWith } from "./errors.js";
import { type Look, LookSchema } from "./schema.js";

/** Built-in looks. Lengths are pixels at a 1920-px-wide window (ruling R1). */
export const LOOKS = {
  // Measured from the JSLab hero (ruling R2): padding 0.09, radius 18, no tilt, a gray sky-to-ground gradient.
  hero: {
    preset: "hero",
    backdrop: {
      type: "gradient",
      angle: 180,
      stops: [
        { at: 0, color: "#8f8f8f" },
        { at: 0.27, color: "#c4c4c4" },
        { at: 0.42, color: "#1a1a1a" },
        { at: 1, color: "#0e0e0e" },
      ],
    },
    padding: 0.09,
    radius: 18,
    shadow: { blur: 60, offsetY: 24, opacity: 0.55 },
    tilt: { rotateX: 0, rotateY: 0, perspective: 2400 },
  },
  flat: {
    preset: "flat",
    backdrop: { type: "none" },
    padding: 0,
    radius: 0,
    shadow: { blur: 0, offsetY: 0, opacity: 0 },
    tilt: { rotateX: 0, rotateY: 0, perspective: 2400 },
  },
} satisfies Record<string, Look>;

/** A preset by name (a fresh copy), or a look object validated against the schema. */
export function resolveLook(look: string | Look): Look {
  if (typeof look !== "string") return parseWith(LookSchema, look, "look");
  const preset = (LOOKS as Record<string, Look>)[look];
  if (!preset) throw new CameraworkError(`unknown look "${look}" (known: ${Object.keys(LOOKS).join(", ")})`);
  return structuredClone(preset);
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/schema.test.ts && bunx tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: file schemas, planner defaults and the hero/flat looks"
```

---

### Task 3: ffmpeg adapters and test helpers

**Files:**
- Create: `src/ffmpeg.ts`, `test/helpers.ts`, `test/ffmpeg.test.ts`

**Interfaces:**
- Consumes: `CameraworkError`, `Probe`.
- Produces:
  - `requireFfmpeg(): void` — throws `CameraworkError` if ffmpeg/ffprobe are missing or older than 6.
  - `probe(path: string): Probe` — fps from `avg_frame_rate` (fallback `r_frame_rate`), duration from the container.
  - `hasEncoder(name: string): boolean` (cached).
  - `runFfmpeg(args: string[]): Promise<void>` — `ffmpeg -v error -y …args`; rejects with the stderr tail.
  - `readFrames(args: string[], frameBytes: number, onFrame: (frame: Buffer, index: number) => void | Promise<void>): Promise<number>` — runs `ffmpeg -v error …args -f rawvideo -`; calls `onFrame` once per complete frame, **sequentially**; the buffer is reused (copy it to keep it); resolves with the frame count.
  - `class FrameSink { constructor(args: string[]); write(frame: Buffer): Promise<void>; end(): Promise<void> }` — runs `ffmpeg -v error -y …args` reading frames on stdin with backpressure; `end()` rejects with a `CameraworkError` if ffmpeg exits non-zero.
- Produces (test helpers): `tmpDir(prefix?: string): string` (a fresh directory whose name contains a space); `makeBoxVideo(path, { width, height, fps, seconds, boxes: { x, y, size, from, to, color? }[] }): Promise<void>`.

- [ ] **Step 1: Write the helpers**

`test/helpers.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "../src/ffmpeg.js";

/** A fresh temp directory. Its name contains a space on purpose (Review Focus 5). */
export function tmpDir(prefix = "camerawork test "): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Box {
  x: number;
  y: number;
  size: number;
  from: number;
  to: number;
  color?: string;
}

/** A synthetic recording: a dark gray frame with solid boxes that appear and disappear at known times. */
export async function makeBoxVideo(
  path: string,
  opts: { width: number; height: number; fps: number; seconds: number; boxes: Box[] },
): Promise<void> {
  const draws = opts.boxes.map(
    (b) =>
      `drawbox=x=${b.x}:y=${b.y}:w=${b.size}:h=${b.size}:color=${b.color ?? "red"}:t=fill:enable='between(t,${b.from},${b.to})'`,
  );
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=0x202020:size=${opts.width}x${opts.height}:rate=${opts.fps}:duration=${opts.seconds}`,
    "-vf",
    draws.length ? draws.join(",") : "null",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "12",
    path,
  ]);
}
```

- [ ] **Step 2: Write the failing tests**

`test/ffmpeg.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CameraworkError } from "../src/errors.js";
import { FrameSink, hasEncoder, probe, readFrames, requireFfmpeg } from "../src/ffmpeg.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

describe("ffmpeg adapters", () => {
  test("requireFfmpeg passes on this machine", () => {
    expect(() => requireFfmpeg()).not.toThrow();
  });

  test("probe reads size, frame rate and duration (60 fps master)", async () => {
    const path = join(tmpDir(), "m.mp4");
    await makeBoxVideo(path, { width: 320, height: 180, fps: 60, seconds: 2, boxes: [] });
    const p = probe(path);
    expect(p).toMatchObject({ path, width: 320, height: 180, fps: 60 });
    expect(p.duration).toBeCloseTo(2, 1);
  });

  test("probe of a missing file is a CameraworkError", () => {
    expect(() => probe("/nope/missing.mov")).toThrow(CameraworkError);
  });

  test("readFrames delivers whole frames in order, even across pipe chunk boundaries", async () => {
    const path = join(tmpDir(), "m.mp4");
    await makeBoxVideo(path, { width: 320, height: 180, fps: 30, seconds: 1, boxes: [] });
    const seen: number[] = [];
    const count = await readFrames(["-i", path, "-vf", "fps=10,format=gray", "-pix_fmt", "gray"], 320 * 180, (f, i) => {
      expect(f.length).toBe(320 * 180);
      seen.push(i);
    });
    expect(count).toBe(10);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("FrameSink encodes raw frames and reports ffmpeg failures", async () => {
    const out = join(tmpDir(), "out.mp4");
    const raw = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", "64x36", "-r", "10", "-i", "-"];
    const sink = new FrameSink([...raw, "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
    const frame = Buffer.alloc(64 * 36 * 4, 200);
    for (let i = 0; i < 10; i++) await sink.write(frame);
    await sink.end();
    expect(probe(out).width).toBe(64);
    const bad = new FrameSink([...raw, "-c:v", "no-such-codec", out]);
    await expect(bad.end()).rejects.toThrow(CameraworkError);
  });

  test("hasEncoder finds libx264", () => {
    expect(hasEncoder("libx264")).toBe(true);
    expect(hasEncoder("definitely-not-an-encoder")).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test test/ffmpeg.test.ts`
Expected: FAIL — cannot find module `../src/ffmpeg.js`.

- [ ] **Step 4: Implement `src/ffmpeg.ts`**

```ts
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { CameraworkError } from "./errors.js";
import type { Probe } from "./schema.js";

const INSTALL_HINT = "Install ffmpeg 6 or later (macOS: brew install ffmpeg; Debian/Ubuntu: sudo apt install ffmpeg).";

/** Throws unless ffmpeg and ffprobe 6+ are on PATH. Git builds ("version N-…") are accepted. */
export function requireFfmpeg(): void {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    const result = spawnSync(bin, ["-version"], { encoding: "utf8" });
    if (result.error || result.status !== 0) throw new CameraworkError(`${bin} was not found on PATH. ${INSTALL_HINT}`);
    const major = /version n?(\d+)\./.exec(result.stdout)?.[1];
    if (major && Number(major) < 6) throw new CameraworkError(`${bin} ${major} is too old. ${INSTALL_HINT}`);
  }
}

function rate(value: string | undefined): number {
  const [num, den] = (value ?? "0/0").split("/").map(Number);
  return num && den ? num / den : 0;
}

/** Size, frame rate and duration of a video's first video stream. */
export function probe(path: string): Probe {
  if (!existsSync(path)) throw new CameraworkError(`cannot read ${path}: no such file`);
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,r_frame_rate:format=duration",
      "-of",
      "json",
      path,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new CameraworkError(`cannot read ${path}: ${result.stderr.trim()}`);
  const json = JSON.parse(result.stdout) as {
    streams?: { width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const stream = json.streams?.[0];
  if (!stream?.width || !stream.height) throw new CameraworkError(`${path} has no video stream`);
  const fps = rate(stream.avg_frame_rate) || rate(stream.r_frame_rate);
  const duration = Number(json.format?.duration);
  if (!fps || !duration) throw new CameraworkError(`cannot read the frame rate or duration of ${path}`);
  return { path, width: stream.width, height: stream.height, fps: Math.round(fps * 1000) / 1000, duration };
}

let encoders: string | null = null;
/** True when this ffmpeg build has the named encoder. */
export function hasEncoder(name: string): boolean {
  encoders ??= spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "";
  return encoders.split("\n").some((line) => line.trim().split(/\s+/)[1] === name);
}

function failure(args: string[], code: number | null, stderr: string): CameraworkError {
  const tail = stderr.trim().split("\n").slice(-6).join("\n");
  return new CameraworkError(`ffmpeg failed (exit ${code}) running: ffmpeg ${args.join(" ")}\n${tail}`);
}

/** Runs `ffmpeg -v error -y …args` to completion. */
export function runFfmpeg(args: string[]): Promise<void> {
  const full = ["-v", "error", "-y", ...args];
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", full, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(failure(full, code, stderr))));
  });
}

/**
 * Runs `ffmpeg -v error …args -f rawvideo -` and calls `onFrame` once per complete frame, in order, one at a time.
 * The frame buffer is reused between calls: copy it to keep it.
 */
export function readFrames(
  args: string[],
  frameBytes: number,
  onFrame: (frame: Buffer, index: number) => void | Promise<void>,
): Promise<number> {
  const full = ["-v", "error", ...args, "-f", "rawvideo", "-"];
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", full, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    const frame = Buffer.allocUnsafe(frameBytes);
    let filled = 0;
    let index = 0;
    let failed: unknown = null;
    let work: Promise<void> = Promise.resolve();
    proc.stdout.on("data", (chunk: Buffer) => {
      proc.stdout.pause();
      work = work.then(async () => {
        let offset = 0;
        while (offset < chunk.length && !failed) {
          const n = Math.min(frameBytes - filled, chunk.length - offset);
          chunk.copy(frame, filled, offset, offset + n);
          filled += n;
          offset += n;
          if (filled === frameBytes) {
            filled = 0;
            try {
              await onFrame(frame, index++);
            } catch (error) {
              failed = error;
              proc.kill("SIGKILL");
            }
          }
        }
        proc.stdout.resume();
      });
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      work.then(() => {
        if (failed) reject(failed);
        else if (code !== 0) reject(failure(full, code, stderr));
        else resolve(index);
      }, reject);
    });
  });
}

/** An ffmpeg process that reads raw frames on stdin (the args must include `-i -`). */
export class FrameSink {
  private readonly proc;
  private readonly done: Promise<void>;

  constructor(args: string[]) {
    const full = ["-v", "error", "-y", ...args];
    this.proc = spawn("ffmpeg", full, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    this.proc.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    this.proc.stdin.on("error", () => {}); // a dead encoder is reported through `done`
    this.done = new Promise((resolve, reject) => {
      this.proc.on("error", reject);
      this.proc.on("close", (code) => (code === 0 ? resolve() : reject(failure(full, code, stderr))));
    });
    this.done.catch(() => {}); // observed by end()
  }

  write(frame: Buffer): Promise<void> {
    if (this.proc.stdin.write(frame)) return Promise.resolve();
    return new Promise((resolve) => this.proc.stdin.once("drain", () => resolve()));
  }

  end(): Promise<void> {
    this.proc.stdin.end();
    return this.done;
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/ffmpeg.test.ts && bunx tsc --noEmit && bunx biome check .`
Expected: 6 pass; clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: ffmpeg adapters (probe, frame reader, frame sink) and synthetic test videos"
```

---

### Task 4: Scene geometry

**Files:**
- Create: `src/geometry.ts`, `test/geometry.test.ts`

**Interfaces:**
- Consumes: `Look`, `Rect`.
- Produces:
  - `type Point = [number, number]`; `type Quad = [Point, Point, Point, Point]` (top-left, top-right, bottom-left, bottom-right — the order of ffmpeg `perspective`'s x0…x3).
  - `const WARP_BORDER = 8`; `lookScale(windowWidth: number): number` (= `windowWidth / 1920`).
  - `tiltQuad(w: number, h: number, tilt: Look["tilt"]): Quad` — window corners after the 3D tilt, fitted inside `w × h`.
  - `homography(src: Quad, dst: Quad): number[]` (9 numbers, row-major, h[8] = 1); `applyH(h: number[], p: Point): Point`.
  - `interface SceneLayout { sceneW: number; sceneH: number; winX: number; winY: number; winW: number; winH: number; quad: Quad; h: number[] }`.
  - `sceneLayout(master: { width: number; height: number }, look: Look, aspect: number): SceneLayout` — window at 1:1 master pixels, `padding` on both axes, scene grown to `aspect`, both scene sides even, window centered.
  - `masterToScene(layout: SceneLayout, p: Point): Point`; `mapRect(layout: SceneLayout, r: Rect): Rect` (bounding box of the mapped corners).

- [ ] **Step 1: Write the failing tests**

`test/geometry.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import {
  applyH,
  homography,
  lookScale,
  mapRect,
  masterToScene,
  type Quad,
  sceneLayout,
  tiltQuad,
} from "../src/geometry.js";
import { LOOKS } from "../src/looks.js";

const near = (a: number[], b: number[], eps = 1e-6) => {
  for (const [i, v] of a.entries()) expect(Math.abs(v - (b[i] as number))).toBeLessThan(eps);
};

describe("homography", () => {
  test("maps the four source corners onto the destination corners", () => {
    const src: Quad = [[0, 0], [100, 0], [0, 50], [100, 50]];
    const dst: Quad = [[10, 5], [90, 0], [0, 50], [100, 45]];
    const h = homography(src, dst);
    for (const [i, p] of src.entries()) near(applyH(h, p), dst[i] as number[]);
  });

  test("is the identity for identical quads", () => {
    const q: Quad = [[0, 0], [10, 0], [0, 10], [10, 10]];
    near(applyH(homography(q, q), [3, 7]), [3, 7]);
  });
});

describe("tiltQuad", () => {
  test("no tilt keeps the rectangle", () => {
    expect(tiltQuad(1920, 1080, { rotateX: 0, rotateY: 0, perspective: 2400 })).toEqual([
      [0, 0],
      [1920, 0],
      [0, 1080],
      [1920, 1080],
    ]);
  });

  test("rotateY makes the far (right) edge shorter, and the quad stays inside the box", () => {
    const q = tiltQuad(1920, 1080, { rotateX: 0, rotateY: 8, perspective: 2400 });
    const left = q[2][1] - q[0][1];
    const right = q[3][1] - q[1][1];
    expect(right).toBeLessThan(left);
    for (const [x, y] of q) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(1920 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(1080 + 1e-9);
    }
  });
});

describe("sceneLayout", () => {
  test("flat look on a same-aspect master: the scene is the master", () => {
    const l = sceneLayout({ width: 3840, height: 2160 }, LOOKS.flat, 16 / 9);
    expect(l).toMatchObject({ sceneW: 3840, sceneH: 2160, winX: 0, winY: 0, winW: 3840, winH: 2160 });
    expect(masterToScene(l, [100, 200])).toEqual([100, 200]);
  });

  test("hero look pads the window by 9 % and keeps it at 1:1 master pixels", () => {
    // 3840 / 0.82 = 4682.9 → 4683 → even 4684; 2160 / 0.82 = 2634.1 → 2635 → even 2636;
    // 4684 / 2636 < 16/9, so the width grows: 2636 × 16/9 = 4686.2 → 4687 → even 4688.
    const l = sceneLayout({ width: 3840, height: 2160 }, LOOKS.hero, 16 / 9);
    expect(l).toMatchObject({ winW: 3840, winH: 2160, sceneW: 4688, sceneH: 2636, winX: 424, winY: 238 });
  });

  test("odd masters give an even scene (Review Focus 2)", () => {
    const l = sceneLayout({ width: 1365, height: 767 }, LOOKS.hero, 1365 / 767);
    expect(l.sceneW % 2).toBe(0);
    expect(l.sceneH % 2).toBe(0);
  });

  test("a wider output aspect grows the scene sideways, keeping the window centered", () => {
    const l = sceneLayout({ width: 1000, height: 1000 }, LOOKS.flat, 2);
    expect(l).toMatchObject({ sceneW: 2000, sceneH: 1000, winX: 500, winY: 0 });
  });

  test("mapRect offsets by the window position", () => {
    const l = sceneLayout({ width: 1000, height: 1000 }, LOOKS.flat, 2);
    expect(mapRect(l, [10, 20, 30, 40])).toEqual([510, 20, 30, 40]);
  });

  test("lookScale is relative to a 1920 window", () => {
    expect(lookScale(3840)).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/geometry.test.ts`
Expected: FAIL — cannot find module `../src/geometry.js`.

- [ ] **Step 3: Implement `src/geometry.ts`**

```ts
import type { Look, Rect } from "./schema.js";

export type Point = [number, number];
export type Quad = [Point, Point, Point, Point];

/** Black border added around the window before the perspective warp (ruling R7). */
export const WARP_BORDER = 8;

/** Look lengths are defined at a 1920-px-wide window (ruling R1). */
export const lookScale = (windowWidth: number): number => windowWidth / 1920;

const even = (n: number): number => (n % 2 === 0 ? n : n + 1);

/** The window's corners (TL, TR, BL, BR) after rotating about X then Y with a perspective, fitted inside w×h. */
export function tiltQuad(w: number, h: number, tilt: Look["tilt"]): Quad {
  if (tilt.rotateX === 0 && tilt.rotateY === 0)
    return [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ];
  const d = tilt.perspective * lookScale(w);
  const rx = (tilt.rotateX * Math.PI) / 180;
  const ry = (tilt.rotateY * Math.PI) / 180;
  const corners: Point[] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [-w / 2, h / 2],
    [w / 2, h / 2],
  ];
  const projected = corners.map(([x, y]): Point => {
    const y1 = y * Math.cos(rx);
    const z1 = y * Math.sin(rx);
    const x2 = x * Math.cos(ry) + z1 * Math.sin(ry);
    const z2 = -x * Math.sin(ry) + z1 * Math.cos(ry);
    const s = d / (d - z2);
    return [x2 * s, y1 * s];
  });
  const xs = projected.map((p) => p[0]);
  const ys = projected.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const k = Math.min(w / (maxX - minX), h / (maxY - minY), 1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return projected.map(([x, y]): Point => [w / 2 + (x - cx) * k, h / 2 + (y - cy) * k]) as Quad;
}

/** Gauss–Jordan elimination with partial pivoting for a small dense system a·x = b. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] as number]);
  const at = (r: number, c: number) => (m[r] as number[])[c] as number;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(at(r, col)) > Math.abs(at(pivot, col))) pivot = r;
    const tmp = m[col] as number[];
    m[col] = m[pivot] as number[];
    m[pivot] = tmp;
    const pivotRow = m[col] as number[];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = m[r] as number[];
      const f = (row[col] as number) / (pivotRow[col] as number);
      for (let c = col; c <= n; c++) row[c] = (row[c] as number) - f * (pivotRow[c] as number);
    }
  }
  return m.map((row, i) => (row[n] as number) / (row[i] as number));
}

/** The 3×3 projective transform (row-major, h[8] = 1) taking each src corner to the matching dst corner. */
export function homography(src: Quad, dst: Quad): number[] {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i] as Point;
    const [u, v] = dst[i] as Point;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return [...solve(a, b), 1];
}

export function applyH(h: number[], [x, y]: Point): Point {
  const g = (i: number) => h[i] as number;
  const w = g(6) * x + g(7) * y + g(8);
  return [(g(0) * x + g(1) * y + g(2)) / w, (g(3) * x + g(4) * y + g(5)) / w];
}

export interface SceneLayout {
  sceneW: number;
  sceneH: number;
  winX: number;
  winY: number;
  winW: number;
  winH: number;
  /** The tilted window corners in window-local pixels (before WARP_BORDER). */
  quad: Quad;
  /** Window-local master pixels → window-local tilted pixels. */
  h: number[];
}

/** Places the master (1:1 pixels) inside a backdrop with `look.padding` on each side, grown to `aspect`. */
export function sceneLayout(master: { width: number; height: number }, look: Look, aspect: number): SceneLayout {
  const winW = master.width;
  const winH = master.height;
  const fit = 1 - 2 * look.padding;
  let sceneW = even(Math.ceil(winW / fit));
  let sceneH = even(Math.ceil(winH / fit));
  if (sceneW / sceneH < aspect - 1e-9) sceneW = even(Math.ceil(sceneH * aspect));
  else if (sceneW / sceneH > aspect + 1e-9) sceneH = even(Math.ceil(sceneW / aspect));
  const quad = tiltQuad(winW, winH, look.tilt);
  const h = homography(
    [
      [0, 0],
      [winW, 0],
      [0, winH],
      [winW, winH],
    ],
    quad,
  );
  return {
    sceneW,
    sceneH,
    winX: Math.round((sceneW - winW) / 2),
    winY: Math.round((sceneH - winH) / 2),
    winW,
    winH,
    quad,
    h,
  };
}

export function masterToScene(layout: SceneLayout, p: Point): Point {
  const [u, v] = applyH(layout.h, p);
  return [u + layout.winX, v + layout.winY];
}

/** The scene-pixel bounding box of a master-pixel rectangle. */
export function mapRect(layout: SceneLayout, [x, y, w, h]: Rect): Rect {
  const corners: Point[] = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ];
  const pts = corners.map((p) => masterToScene(layout, p));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const round = (n: number) => Math.round(n * 100) / 100;
  return [round(minX), round(minY), round(Math.max(...xs) - minX), round(Math.max(...ys) - minY)];
}
```

(With the flat look and `sceneW / sceneH` equal to `aspect`, neither branch runs, so a 3840×2160 master stays 3840×2160.)

- [ ] **Step 4: Run the tests**

Run: `bun test test/geometry.test.ts && bunx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: scene geometry (layout, tilt quad, homography)"
```

---

### Task 5: Change detection core (pure)

**Files:**
- Create: `src/detect/diff.ts`, `src/detect/blink.ts`, `test/diff.test.ts`, `test/blink.test.ts`

**Interfaces:**
- Consumes: `Rect`, `Change`.
- Produces:
  - `diffMask(prev: Uint8Array, cur: Uint8Array, threshold: number): Uint8Array` — 1 where `|cur − prev| > threshold`.
  - `zeroRects(mask: Uint8Array, w: number, h: number, rects: Rect[]): void`.
  - `interface Region { rect: Rect; count: number }`; `findRegions(mask, w, h, mergeDist: number, minCount: number): Region[]` — 8-connected components, boxes merged while their gap ≤ `mergeDist`, then regions with fewer than `minCount` changed pixels dropped.
  - `iou(a: Rect, b: Rect): number`; `interface BlinkOptions { minPeriod; maxPeriod; minRepeats; iou; jitter }`; `DEFAULT_BLINK = { minPeriod: 0.3, maxPeriod: 1.5, minRepeats: 3, iou: 0.6, jitter: 0.25 }`; `filterBlinks(changes: Change[], opts?: BlinkOptions): Change[]`.

- [ ] **Step 1: Write the failing tests**

`test/diff.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { diffMask, findRegions, zeroRects } from "../src/detect/diff.js";

const W = 20;
const H = 10;
const frame = (fill: (x: number, y: number) => number) => {
  const f = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = fill(x, y);
  return f;
};
const blank = frame(() => 30);

describe("diffMask", () => {
  test("marks only pixels that changed by more than the threshold", () => {
    const cur = frame((x, y) => (x === 3 && y === 4 ? 200 : x === 5 && y === 5 ? 40 : 30));
    const m = diffMask(blank, cur, 12);
    expect(m[4 * W + 3]).toBe(1);
    expect(m[5 * W + 5]).toBe(0);
    expect(m.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe("findRegions", () => {
  test("one solid block is one region with its bounding box and pixel count", () => {
    const m = diffMask(blank, frame((x, y) => (x >= 2 && x < 6 && y >= 1 && y < 4 ? 255 : 30)), 12);
    expect(findRegions(m, W, H, 0, 1)).toEqual([{ rect: [2, 1, 4, 3], count: 12 }]);
  });

  test("blocks within the merge distance merge; farther ones stay apart", () => {
    // Pixels at x=1 and x=4 on row 1 are 2 columns apart (gap 2 = mergeDist): merged.
    const two = frame((x, y) => (((x === 1 || x === 4) && y === 1) || (x === 15 && y === 8) ? 255 : 30));
    const regions = findRegions(diffMask(blank, two, 12), W, H, 2, 1);
    expect(regions.map((r) => r.rect)).toEqual([
      [1, 1, 4, 1],
      [15, 8, 1, 1],
    ]);
  });

  test("regions below the minimum pixel count are dropped", () => {
    const m = diffMask(blank, frame((x, y) => (x === 0 && y === 0 ? 255 : 30)), 12);
    expect(findRegions(m, W, H, 0, 2)).toEqual([]);
  });

  test("zeroRects masks an area out", () => {
    const m = diffMask(blank, frame((_x, y) => (y === 0 ? 255 : 30)), 12);
    zeroRects(m, W, H, [[0, 0, 10, 1]]);
    expect(findRegions(m, W, H, 0, 1).map((r) => r.rect)).toEqual([[10, 0, 10, 1]]);
  });
});
```

`test/blink.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { filterBlinks, iou } from "../src/detect/blink.js";
import type { Change } from "../src/schema.js";

const at = (t: number, x = 100): Change => ({ t, rect: [x, 50, 4, 30], strength: 1 });

describe("iou", () => {
  test("identical boxes are 1 and disjoint boxes are 0", () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iou([0, 0, 10, 10], [20, 20, 5, 5])).toBe(0);
  });
});

describe("filterBlinks", () => {
  test("a cursor blinking every 0.53 s in one place is dropped", () => {
    expect(filterBlinks([0.5, 1.03, 1.56, 2.09, 2.62].map((t) => at(t)))).toEqual([]);
  });

  test("typing (moving changes) and a one-off change are kept", () => {
    const typing = [0.1, 0.2, 0.35, 0.5].map((t, i) => at(t, 100 + i * 12));
    const once: Change = { t: 3, rect: [400, 400, 50, 50], strength: 0.8 };
    expect(filterBlinks([...typing, once])).toHaveLength(5);
  });

  test("an irregular repeat in one place is not a blink", () => {
    expect(filterBlinks([0.5, 0.9, 2.4, 2.7].map((t) => at(t)))).toHaveLength(4);
  });

  test("full-frame changes always survive", () => {
    const full = [1, 2, 3].map((t): Change => ({ t, rect: [0, 0, 1920, 1080], strength: 1, fullFrame: true }));
    expect(filterBlinks(full)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/diff.test.ts test/blink.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/detect/diff.ts`**

```ts
import type { Rect } from "../schema.js";

/** 1 where a grayscale pixel changed by more than `threshold`, else 0. */
export function diffMask(prev: Uint8Array, cur: Uint8Array, threshold: number): Uint8Array {
  const mask = new Uint8Array(cur.length);
  for (let i = 0; i < cur.length; i++) if (Math.abs((cur[i] as number) - (prev[i] as number)) > threshold) mask[i] = 1;
  return mask;
}

/** Clears the mask inside each rectangle (analysis pixels), clamped to the frame. */
export function zeroRects(mask: Uint8Array, w: number, h: number, rects: Rect[]): void {
  for (const [rx, ry, rw, rh] of rects) {
    const x0 = Math.max(0, Math.floor(rx));
    const y0 = Math.max(0, Math.floor(ry));
    const x1 = Math.min(w, Math.ceil(rx + rw));
    const y1 = Math.min(h, Math.ceil(ry + rh));
    for (let y = y0; y < y1; y++) mask.fill(0, y * w + x0, y * w + x1);
  }
}

export interface Region {
  rect: Rect;
  count: number;
}

const gap = (a: Rect, b: Rect): number => {
  const dx = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]));
  const dy = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]));
  return Math.max(dx, dy);
};

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
};

/** 8-connected changed areas as bounding boxes, merged while within `mergeDist`, small ones dropped. */
export function findRegions(mask: Uint8Array, w: number, h: number, mergeDist: number, minCount: number): Region[] {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const regions: Region[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let count = 0;
    while (sp > 0) {
      const p = stack[--sp] as number;
      const x = p % w;
      const y = (p - x) / w;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    regions.push({ rect: [minX, minY, maxX - minX + 1, maxY - minY + 1], count });
  }
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < regions.length && !merged; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i] as Region;
        const b = regions[j] as Region;
        if (gap(a.rect, b.rect) <= mergeDist) {
          regions[i] = { rect: union(a.rect, b.rect), count: a.count + b.count };
          regions.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return regions.filter((r) => r.count >= minCount);
}
```

- [ ] **Step 4: Implement `src/detect/blink.ts`**

```ts
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

/** Drops changes that repeat in one place at a steady rhythm (a text cursor, a spinner). */
export function filterBlinks(changes: Change[], opts: BlinkOptions = DEFAULT_BLINK): Change[] {
  const groups: Change[][] = [];
  for (const c of changes) {
    if (c.fullFrame) continue;
    const group = groups.find((g) => iou((g[g.length - 1] as Change).rect, c.rect) >= opts.iou);
    if (group) group.push(c);
    else groups.push([c]);
  }
  const blinks = new Set<Change>();
  for (const g of groups) {
    if (g.length < opts.minRepeats) continue;
    const gaps = g.slice(1).map((c, i) => c.t - (g[i] as Change).t);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    if (median < opts.minPeriod || median > opts.maxPeriod) continue;
    if (gaps.every((x) => Math.abs(x - median) <= median * opts.jitter)) for (const c of g) blinks.add(c);
  }
  return changes.filter((c) => !blinks.has(c));
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/diff.test.ts test/blink.test.ts && bunx tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: frame differencing, region finding and the blink filter"
```

---

### Task 6: `detect()`

**Files:**
- Create: `src/detect/index.ts`, `test/detect.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `requireFfmpeg`, `probe`, `readFrames` (Task 3); `diffMask`, `zeroRects`, `findRegions`, `filterBlinks` (Task 5); `ChangesFile`, `Rect`.
- Produces: `interface DetectOptions { masks?: Rect[]; threshold?: number; analysisFps?: number; scale?: number }`; `detect(masterPath: string, opts?: DetectOptions): Promise<ChangesFile>`; `const ANALYSIS_FPS = 15`.

- [ ] **Step 1: Write the failing test**

`test/detect.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { detect } from "../src/detect/index.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

describe("detect", () => {
  test("finds each box when it appears, in master pixels, from a 60 fps master (Review Focus 1)", async () => {
    const path = join(tmpDir(), "boxes.mp4");
    await makeBoxVideo(path, {
      width: 1280,
      height: 720,
      fps: 60,
      seconds: 4,
      boxes: [
        { x: 160, y: 120, size: 96, from: 1, to: 4 },
        { x: 960, y: 520, size: 96, from: 2.5, to: 4 },
      ],
    });
    const result = await detect(path);
    expect(result.master).toMatchObject({ width: 1280, height: 720, fps: 60 });
    const first = result.changes.find((c) => Math.abs(c.t - 1) < 0.1);
    const second = result.changes.find((c) => Math.abs(c.t - 2.5) < 0.1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const [x1, y1, w1, h1] = first?.rect ?? [0, 0, 0, 0];
    expect(x1).toBeGreaterThan(140);
    expect(x1).toBeLessThan(180);
    expect(y1).toBeGreaterThan(100);
    expect(y1).toBeLessThan(140);
    expect(w1).toBeGreaterThan(80);
    expect(h1).toBeGreaterThan(80);
    expect(second?.rect[0]).toBeGreaterThan(930);
  });

  test("masked areas produce no changes", async () => {
    const path = join(tmpDir(), "boxes.mp4");
    await makeBoxVideo(path, {
      width: 640,
      height: 360,
      fps: 30,
      seconds: 2,
      boxes: [{ x: 40, y: 40, size: 60, from: 1, to: 2 }],
    });
    const result = await detect(path, { masks: [[0, 0, 200, 200]] });
    expect(result.changes).toEqual([]);
  });

  test("a change covering most of the frame is one full-frame change", async () => {
    const path = join(tmpDir(), "flash.mp4");
    await makeBoxVideo(path, {
      width: 640,
      height: 360,
      fps: 30,
      seconds: 2,
      boxes: [{ x: 0, y: 0, size: 640, from: 1, to: 2, color: "white" }],
    });
    const result = await detect(path);
    const flash = result.changes.filter((c) => Math.abs(c.t - 1) < 0.1);
    expect(flash).toHaveLength(1);
    expect(flash[0]).toMatchObject({ rect: [0, 0, 640, 360], fullFrame: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/detect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/detect/index.ts`**

```ts
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
```

- [ ] **Step 4: Export it**

In `src/index.ts`, add:
```ts
export { type DetectOptions, detect } from "./detect/index.js";
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/detect.test.ts && bunx tsc --noEmit`
Expected: 3 pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: detect() finds changed regions in a master"
```

---

### Task 7: Cues and framing

**Files:**
- Create: `src/plan/cues.ts`, `src/plan/framing.ts`, `test/cues.test.ts`, `test/framing.test.ts`

**Interfaces:**
- Consumes: `CameraworkError`; `Change`, `CueFile`, `Probe`, `Rect`, `View`; `SceneLayout` (Task 4).
- Produces:
  - `interface PlanEvent { start: number; end: number; rect: Rect; source: "auto" | "cue"; zoom?: number; wide?: boolean }` (rect in **master** pixels).
  - `validateCues(file: CueFile, master: Probe): void`.
  - `toEvents(changes: Change[], cues: CueFile | undefined, minHold: number, frameStep: number): PlanEvent[]` (sorted by start).
  - `wideView(layout: SceneLayout): View`; `unionRect(a: Rect, b: Rect): Rect`; `frameRect(rect: Rect, layout: SceneLayout, margin: number, maxZoom: number, zoomOverride?: number): View` (rect in **scene** pixels).

- [ ] **Step 1: Write the failing tests**

`test/cues.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { CameraworkError } from "../src/errors.js";
import { toEvents, validateCues } from "../src/plan/cues.js";
import type { Change, CueFile } from "../src/schema.js";

const master = { path: "m.mov", width: 1920, height: 1080, fps: 30, duration: 10 };
const change = (t: number, x = 10): Change => ({ t, rect: [x, 10, 50, 50], strength: 1 });

describe("validateCues", () => {
  test("names the cue that is out of range", () => {
    const file: CueFile = {
      version: 1,
      cues: [
        { t: 1, wide: true },
        { t: 12, rect: [0, 0, 10, 10], label: "late" },
      ],
    };
    expect(() => validateCues(file, master)).toThrow('cue 1 ("late"): t=12 is after the end of the video (10.00 s)');
  });

  test("rejects a rect outside the video and an empty ignore range", () => {
    expect(() => validateCues({ version: 1, cues: [{ t: 1, rect: [1900, 0, 50, 10] }] }, master)).toThrow(
      CameraworkError,
    );
    expect(() => validateCues({ version: 1, cues: [{ from: 3, to: 3, ignore: true }] }, master)).toThrow(
      'cue 0: "from" must be before "to"',
    );
  });
});

describe("toEvents", () => {
  test("auto changes become events lasting one analysis frame", () => {
    expect(toEvents([change(2)], undefined, 1.2, 1 / 15)).toEqual([
      { start: 2, end: 2 + 1 / 15, rect: [10, 10, 50, 50], source: "auto" },
    ]);
  });

  test("a cue wins inside its window and ignore ranges drop changes", () => {
    const cues: CueFile = {
      version: 1,
      cues: [
        { t: 1, rect: [500, 500, 100, 100], hold: 2, zoom: 1.8 },
        { from: 5, to: 6, ignore: true },
        { t: 8, wide: true },
      ],
    };
    const events = toEvents([change(1.5), change(4), change(5.5), change(8.5)], cues, 1.2, 1 / 15);
    expect(events.map((e) => [e.start, e.source, e.wide ?? false])).toEqual([
      [1, "cue", false],
      [4, "auto", false],
      [8, "cue", true],
    ]);
    expect(events[0]).toMatchObject({ end: 3, zoom: 1.8 });
    expect(events[2]?.end).toBeCloseTo(9.2);
  });

  test("full-frame changes become wide events", () => {
    const full: Change = { t: 3, rect: [0, 0, 1920, 1080], strength: 1, fullFrame: true };
    expect(toEvents([full], undefined, 1.2, 1 / 15)[0]?.wide).toBe(true);
  });
});
```

`test/framing.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS } from "../src/looks.js";
import { frameRect, unionRect, wideView } from "../src/plan/framing.js";

const layout = sceneLayout({ width: 1920, height: 1080 }, LOOKS.flat, 16 / 9);

describe("framing", () => {
  test("wide is the scene center at zoom 1", () => {
    expect(wideView(layout)).toEqual({ cx: 960, cy: 540, zoom: 1 });
  });

  test("a small target zooms in to the cap", () => {
    expect(frameRect([900, 500, 20, 20], layout, 0.12, 2.2)).toEqual({ cx: 910, cy: 510, zoom: 2.2 });
  });

  test("the margin sets the zoom: 480 px + 12 % each side = 595.2 px → zoom 3.23 (cap 4)", () => {
    expect(frameRect([0, 0, 480, 100], layout, 0.12, 4).zoom).toBeCloseTo(1920 / 595.2, 5);
  });

  test("a tall target is limited by height through the aspect ratio", () => {
    expect(frameRect([900, 0, 50, 900], layout, 0, 4).zoom).toBeCloseTo(1080 / 900, 5);
  });

  test("a target bigger than the scene stays wide", () => {
    expect(frameRect([0, 0, 1900, 1070], layout, 0.12, 2.2)).toEqual({ cx: 960, cy: 540, zoom: 1 });
  });

  test("the view is pushed inside the scene near an edge", () => {
    expect(frameRect([0, 0, 40, 40], layout, 0.12, 2)).toEqual({ cx: 480, cy: 270, zoom: 2 });
  });

  test("a zoom override is clamped to [1, maxZoom]", () => {
    expect(frameRect([900, 500, 20, 20], layout, 0.12, 2.2, 5).zoom).toBe(2.2);
    expect(frameRect([900, 500, 20, 20], layout, 0.12, 2.2, 1.5).zoom).toBe(1.5);
  });

  test("unionRect", () => {
    expect(unionRect([0, 0, 10, 10], [20, 5, 10, 10])).toEqual([0, 0, 30, 15]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/cues.test.ts test/framing.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/plan/cues.ts`**

```ts
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
export function toEvents(changes: Change[], cues: CueFile | undefined, minHold: number, frameStep: number): PlanEvent[] {
  const windows: [number, number][] = [];
  const events: PlanEvent[] = [];
  for (const cue of cues?.cues ?? []) {
    if ("ignore" in cue) {
      windows.push([cue.from, cue.to]);
      continue;
    }
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
    events.push({ start: c.t, end: c.t + frameStep, rect: c.rect, source: "auto", ...(c.fullFrame ? { wide: true } : {}) });
  }
  return events.sort((a, b) => a.start - b.start);
}
```

(The message for an out-of-range `t` reads `cue 1 ("late"): t=12 is after the end of the video (10.00 s)`.)

- [ ] **Step 4: Implement `src/plan/framing.ts`**

```ts
import type { SceneLayout } from "../geometry.js";
import type { Rect, View } from "../schema.js";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const wideView = (layout: SceneLayout): View => ({ cx: layout.sceneW / 2, cy: layout.sceneH / 2, zoom: 1 });

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

/** The smallest scene-aspect view holding `rect` (scene pixels) plus `margin` on each side, zoom in [1, maxZoom]. */
export function frameRect(
  rect: Rect,
  layout: SceneLayout,
  margin: number,
  maxZoom: number,
  zoomOverride?: number,
): View {
  const aspect = layout.sceneW / layout.sceneH;
  const [x, y, w, h] = rect;
  const needW = Math.max(w * (1 + 2 * margin), h * (1 + 2 * margin) * aspect);
  const zoom = clamp(zoomOverride ?? layout.sceneW / needW, 1, maxZoom);
  const vw = layout.sceneW / zoom;
  const vh = layout.sceneH / zoom;
  return {
    cx: clamp(x + w / 2, vw / 2, layout.sceneW - vw / 2),
    cy: clamp(y + h / 2, vh / 2, layout.sceneH - vh / 2),
    zoom,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/cues.test.ts test/framing.test.ts && bunx tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: cue validation, change/cue merging and shot framing"
```

---

### Task 8: Shots and camera interpolation

**Files:**
- Create: `src/plan/shots.ts`, `src/plan/interp.ts`, `test/shots.test.ts`, `test/interp.test.ts`

**Interfaces:**
- Consumes: `PlanEvent`, `frameRect`, `unionRect`, `wideView` (Task 7); `mapRect`, `SceneLayout` (Task 4); `Shot`, `Keyframe`, `View`, `PlannerParams`.
- Produces:
  - `clusterShots(events: PlanEvent[], layout: SceneLayout, p: PlannerParams): Shot[]` — `p.maxZoom` is the effective cap.
  - `easeInOutCubic(u: number): number`; `cameraAt(keyframes: Keyframe[], t: number): View` — eased segments; zoom geometric, center linear.

- [ ] **Step 1: Write the failing tests**

`test/shots.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS } from "../src/looks.js";
import type { PlanEvent } from "../src/plan/cues.js";
import { clusterShots } from "../src/plan/shots.js";
import { DEFAULT_PLANNER } from "../src/schema.js";

const layout = sceneLayout({ width: 1920, height: 1080 }, LOOKS.flat, 16 / 9);
const auto = (start: number, x: number, y = 500): PlanEvent => ({
  start,
  end: start + 1 / 15,
  rect: [x, y, 20, 20],
  source: "auto",
});

describe("clusterShots", () => {
  test("a typing burst along one line is one shot whose target grows", () => {
    const typing = [0, 0.1, 0.2, 0.3, 0.4].map((t, i) => auto(1 + t, 600 + i * 14));
    const shots = clusterShots(typing, layout, DEFAULT_PLANNER);
    expect(shots).toHaveLength(1);
    expect(shots[0]?.rect).toEqual([600, 500, 76, 20]);
    expect(shots[0]?.start).toBe(1);
  });

  test("a pause longer than shotJoinGap starts a new shot", () => {
    expect(clusterShots([auto(1, 600), auto(2, 620)], layout, DEFAULT_PLANNER)).toHaveLength(2);
  });

  test("a change far away (needing a much wider view) starts a new shot even without a pause", () => {
    expect(clusterShots([auto(1, 100, 100), auto(1.1, 1700, 900)], layout, DEFAULT_PLANNER)).toHaveLength(2);
  });

  test("cues are always their own shot, with their zoom override", () => {
    const cue: PlanEvent = { start: 1.05, end: 3, rect: [600, 500, 40, 20], source: "cue", zoom: 1.5 };
    const shots = clusterShots([auto(1, 600), cue], layout, DEFAULT_PLANNER);
    expect(shots).toHaveLength(2);
    expect(shots[1]).toMatchObject({ source: "cue", view: { zoom: 1.5 } });
  });

  test("wide events become wide shots", () => {
    const shots = clusterShots(
      [{ start: 2, end: 3, rect: [0, 0, 1, 1], source: "cue", wide: true }],
      layout,
      DEFAULT_PLANNER,
    );
    expect(shots[0]?.view).toEqual({ cx: 960, cy: 540, zoom: 1 });
  });
});
```

`test/interp.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { cameraAt, easeInOutCubic } from "../src/plan/interp.js";

const kfs = [
  { t: 0, cx: 960, cy: 540, zoom: 1 },
  { t: 1, cx: 960, cy: 540, zoom: 1 },
  { t: 2, cx: 500, cy: 300, zoom: 2 },
];

describe("interpolation", () => {
  test("easing is 0 → 0.5 → 1 and symmetric", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 10);
  });

  test("holds before, between equal keyframes and after", () => {
    expect(cameraAt(kfs, -1)).toEqual({ cx: 960, cy: 540, zoom: 1 });
    expect(cameraAt(kfs, 0.5)).toEqual({ cx: 960, cy: 540, zoom: 1 });
    expect(cameraAt(kfs, 9)).toEqual({ cx: 500, cy: 300, zoom: 2 });
  });

  test("halfway through a move: center halfway, zoom the geometric mean", () => {
    const v = cameraAt(kfs, 1.5);
    expect(v.cx).toBeCloseTo(730, 6);
    expect(v.cy).toBeCloseTo(420, 6);
    expect(v.zoom).toBeCloseTo(Math.SQRT2, 6);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/shots.test.ts test/interp.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/plan/shots.ts`**

```ts
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
    if (cur && !wide && !cur.wide && e.source === "auto" && cur.source === "auto" && e.start <= cur.end + p.shotJoinGap) {
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
```

- [ ] **Step 4: Implement `src/plan/interp.ts`**

```ts
import type { Keyframe, View } from "../schema.js";

export const easeInOutCubic = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

const view = (k: Keyframe): View => ({ cx: k.cx, cy: k.cy, zoom: k.zoom });

/**
 * The camera at time t: eased between keyframes, zoom geometric (constant perceived speed), center linear.
 * The geometric mean of zooms keeps the view inside the scene whenever both endpoint views are.
 */
export function cameraAt(keyframes: Keyframe[], t: number): View {
  const first = keyframes[0] as Keyframe;
  const last = keyframes[keyframes.length - 1] as Keyframe;
  if (t <= first.t) return view(first);
  if (t >= last.t) return view(last);
  let i = 0;
  while (i < keyframes.length - 2 && (keyframes[i + 1] as Keyframe).t <= t) i++;
  const a = keyframes[i] as Keyframe;
  const b = keyframes[i + 1] as Keyframe;
  if (b.t === a.t) return view(b);
  const u = easeInOutCubic((t - a.t) / (b.t - a.t));
  return {
    cx: a.cx + (b.cx - a.cx) * u,
    cy: a.cy + (b.cy - a.cy) * u,
    zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * u),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/shots.test.ts test/interp.test.ts && bunx tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: shot clustering and eased camera interpolation"
```

---

### Task 9: Camera path

**Files:**
- Create: `src/plan/path.ts`, `test/path.test.ts`

**Interfaces:**
- Consumes: `Shot`, `Keyframe`, `View`, `PlannerParams`, `SceneLayout`, `wideView`.
- Produces: `MIN_MOVE = 0.4`; `moveDuration(a: View, b: View, layout: SceneLayout, p: PlannerParams): number`; `buildKeyframes(shots: Shot[], layout: SceneLayout, p: PlannerParams, duration: number, loop: boolean): Keyframe[]`.

Behavior (spec §5.3), for each shot in order: `arriveBy = max(0, start − anticipation)`; `free` = when the camera may leave its current view (after the previous shot's `end`, and at least `minHold` after arriving). **Via wide** (ease out, hold wide, ease in) when both views are zoomed, out+in fit before `arriveBy`, and either the idle window ≥ `idleWide` or the zoom changes by more than `panZoomTolerance` with a window ≥ `zoomOutGap`. Otherwise a **direct move** leaving at `max(free, arriveBy − moveDuration)`. A repeated view with an idle window ≥ `idleWide` + out + in drifts wide and back. **End:** `loop` returns to wide exactly at `duration`; otherwise the camera drifts wide when ≥ `idleWide` remains. **Non-loop start:** begin on the first shot's view when there isn't time to move there from wide. Moves are only compressed below their caps at the very end of a video (documented compromise).

- [ ] **Step 1: Write the failing tests**

`test/path.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS } from "../src/looks.js";
import { cameraAt } from "../src/plan/interp.js";
import { buildKeyframes, MIN_MOVE, moveDuration } from "../src/plan/path.js";
import { DEFAULT_PLANNER as P, type Shot } from "../src/schema.js";

const layout = sceneLayout({ width: 1920, height: 1080 }, LOOKS.flat, 16 / 9);
const wide = { cx: 960, cy: 540, zoom: 1 };
const shot = (start: number, end: number, cx: number, cy: number, zoom: number): Shot => ({
  start,
  end,
  rect: [cx - 10, cy - 10, 20, 20],
  view: { cx, cy, zoom },
  source: "auto",
});
const times = (k: { t: number }[]) => k.map((f) => f.t);
const ordered = (k: { t: number }[]) => times(k).every((t, i, a) => i === 0 || t >= (a[i - 1] as number));

describe("moveDuration", () => {
  test("respects the pan-speed and zoom-rate caps, never below MIN_MOVE", () => {
    expect(moveDuration(wide, wide, layout, P)).toBe(MIN_MOVE);
    // 1152 px = 0.6 scene widths → 1 s at 0.6 widths/s
    expect(moveDuration(wide, { cx: 960 + 1152, cy: 540, zoom: 1 }, layout, P)).toBeCloseTo(1, 6);
    // zoom 1 → 2.25 = 1.5² → 2 s at 1.5×/s
    expect(moveDuration(wide, { cx: 960, cy: 540, zoom: 2.25 }, layout, P)).toBeCloseTo(2, 6);
  });
});

describe("buildKeyframes", () => {
  test("no shots: one wide hold over the whole video (Review Focus 3)", () => {
    expect(buildKeyframes([], layout, P, 6, false)).toEqual([
      { t: 0, ...wide },
      { t: 6, ...wide },
    ]);
  });

  test("the camera arrives `anticipation` seconds before the shot and holds at least minHold", () => {
    const k = buildKeyframes([shot(3, 3.2, 500, 400, 2)], layout, P, 10, false);
    expect(ordered(k)).toBe(true);
    expect(k.find((f) => f.zoom === 2)?.t).toBeCloseTo(3 - P.anticipation, 6);
    expect(cameraAt(k, 3 - P.anticipation + P.minHold - 0.01)).toEqual({ cx: 500, cy: 400, zoom: 2 });
  });

  test("a shot at t=0.1 starts already framed, never at negative time (Review Focus 4)", () => {
    const k = buildKeyframes([shot(0.1, 1, 500, 400, 2)], layout, P, 5, false);
    expect(k[0]).toEqual({ t: 0, cx: 500, cy: 400, zoom: 2 });
    expect(Math.min(...times(k))).toBe(0);
  });

  test("a shot near the end never pushes a keyframe past the duration (Review Focus 4)", () => {
    const k = buildKeyframes([shot(5.8, 5.9, 500, 400, 2)], layout, P, 6, true);
    expect(Math.max(...times(k))).toBe(6);
    expect(k[k.length - 1]).toMatchObject(wide);
  });

  test("similar zooms pan directly; very different zooms with a long gap go via wide", () => {
    const pan = buildKeyframes([shot(1, 2, 500, 400, 2), shot(3, 4, 1200, 600, 2.1)], layout, P, 8, false);
    // Between the two shots (before the idle drift back to wide after shot 2) the camera never goes wide.
    expect(pan.filter((f) => f.zoom === 1 && f.t > 0 && f.t < 4)).toHaveLength(0);
    const out = buildKeyframes([shot(1, 2, 500, 400, 2.2), shot(7, 8, 1300, 700, 1.3)], layout, P, 12, false);
    expect(out.some((f) => f.zoom === 1 && f.t > 2 && f.t < 7)).toBe(true);
  });

  test("loop mode starts and ends wide", () => {
    const k = buildKeyframes([shot(2, 3, 500, 400, 2)], layout, P, 8, true);
    expect(k[0]).toEqual({ t: 0, ...wide });
    expect(k[k.length - 1]).toEqual({ t: 8, ...wide });
  });

  test("no move is faster than its caps allow", () => {
    const shots = [shot(1.5, 2, 300, 300, 2.2), shot(2.6, 3, 1600, 800, 2.2), shot(5, 6, 900, 500, 1.4)];
    const k = buildKeyframes(shots, layout, P, 9, true);
    for (let i = 1; i < k.length; i++) {
      const a = k[i - 1] as (typeof k)[number];
      const b = k[i] as (typeof k)[number];
      if (a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom) continue;
      expect(b.t - a.t).toBeGreaterThanOrEqual(moveDuration(a, b, layout, P) - 1e-6);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/path.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/plan/path.ts`**

```ts
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
      if (!same(cur, wide) && window >= p.idleWide + outD + inD) viaWide(cur, free + p.idleWide, outD, arriveBy, inD, target);
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
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/path.test.ts && bunx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: camera path planning (anticipation, holds, pan vs zoom-out, caps, loops)"
```

---

### Task 10: `plan()` and file I/O

**Files:**
- Create: `src/plan/index.ts`, `test/plan.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9.
- Produces:
  - `interface PlanOptions { cues?: CueFile; changes?: ChangesFile; look?: string | Look; loop?: boolean; output?: Partial<OutputSettings>; planner?: Partial<PlannerParams>; masks?: Rect[] }`
  - `plan(masterPath: string, opts?: PlanOptions): Promise<Plan>`
  - `readJson(path: string): unknown`; `writeJsonAtomic(path: string, data: unknown): void`
  - `readPlan(path: string): Plan`; `readCueFile(path: string): CueFile`; `readChangesFile(path: string): ChangesFile`

- [ ] **Step 1: Write the failing tests**

`test/plan.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CameraworkError } from "../src/errors.js";
import { plan, readCueFile, readPlan, writeJsonAtomic } from "../src/plan/index.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

describe("plan", () => {
  test("frames a box that appears, and records every setting used", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, {
      width: 1280,
      height: 720,
      fps: 30,
      seconds: 6,
      boxes: [{ x: 200, y: 150, size: 80, from: 2, to: 6 }],
    });
    const p = await plan(master, { look: "flat", output: { width: 640 } });
    expect(p.scene).toEqual({ width: 1280, height: 720 });
    expect(p.maxZoom).toBe(2); // 1280 / 640 caps the default 2.2 (ruling R5)
    expect(p.shots.length).toBeGreaterThanOrEqual(1);
    const framed = p.keyframes.find((k) => k.zoom > 1);
    expect(framed?.cx).toBeLessThan(640);
    expect(p.output).toMatchObject({ width: 640, fps: 30, formats: ["mp4", "webm"], poster: "jpg", quality: "medium" });
    writeJsonAtomic(join(dir, "plan.json"), p);
    expect(readPlan(join(dir, "plan.json"))).toEqual(p);
  });

  test("no changes → wide keyframes only (Review Focus 3)", async () => {
    const master = join(tmpDir(), "still.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 3, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640 } });
    expect(p.shots).toEqual([]);
    expect(p.keyframes.every((k) => k.zoom === 1)).toBe(true);
  });

  test("an output wider than the scene is refused, naming the fix", async () => {
    const master = join(tmpDir(), "small.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    await expect(plan(master, { look: "flat", output: { width: 1280 } })).rejects.toThrow("Use --width 640 or less");
  });

  test("a cue past the end is rejected", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 2, boxes: [] });
    writeFileSync(join(dir, "cues.json"), JSON.stringify({ version: 1, cues: [{ t: 9, wide: true }] }));
    const cues = readCueFile(join(dir, "cues.json"));
    await expect(plan(master, { cues, look: "flat", output: { width: 640 } })).rejects.toThrow(CameraworkError);
  });

  test("readCueFile names the file on invalid JSON", () => {
    const path = join(tmpDir(), "bad.json");
    writeFileSync(path, "{ nope");
    expect(() => readCueFile(path)).toThrow(`${path} is not valid JSON`);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/plan/index.ts`**

```ts
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
import { clusterShots } from "./shots.js";

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
    shots,
    keyframes,
  };
}
```

- [ ] **Step 4: Export**

In `src/index.ts`, add:
```ts
export { LOOKS, resolveLook } from "./looks.js";
export { type PlanOptions, plan, readChangesFile, readCueFile, readPlan, writeJsonAtomic } from "./plan/index.js";
export * from "./schema.js";
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/plan.test.ts && bunx tsc --noEmit`
Expected: 5 pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: plan() from master + cues to a validated, reproducible plan.json"
```

---

### Task 11: Look assets and the scene graph

**Files:**
- Create: `src/render/assets.ts`, `src/render/scene.ts`, `test/scene.test.ts`

**Interfaces:**
- Consumes: `SceneLayout`, `WARP_BORDER`, `lookScale` (Task 4); `Look`; `runFfmpeg` (Task 3); `@napi-rs/canvas`.
- Produces:
  - `interface LookAssets { backdrop: string; mask: string | null; shadow: string | null; shadowX: number; shadowY: number }` — PNG paths in `workDir`. `mask` is null **only** when the window is the whole scene and needs no rounding, tilt or shadow.
  - `makeLookAssets(layout: SceneLayout, look: Look, workDir: string): Promise<LookAssets>`.
  - `perspectiveExpr(layout: SceneLayout): string | null` (null when untilted).
  - `sceneArgs(masterPath: string, layout: SceneLayout, assets: LookAssets, fps: number): string[]` — `readFrames` args producing **RGBA scene frames** of `sceneW × sceneH`.

- [ ] **Step 1: Write the failing test**

`test/scene.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFrames } from "../src/ffmpeg.js";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS, resolveLook } from "../src/looks.js";
import { makeLookAssets } from "../src/render/assets.js";
import { perspectiveExpr, sceneArgs } from "../src/render/scene.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

const pixel = (f: Buffer, w: number, x: number, y: number) => [...f.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];

async function firstSceneFrame(lookName: "hero" | "flat", tilt = false) {
  const dir = tmpDir();
  const master = join(dir, "m.mp4");
  await makeBoxVideo(master, {
    width: 640,
    height: 360,
    fps: 30,
    seconds: 1,
    boxes: [{ x: 0, y: 0, size: 640, from: 0, to: 1, color: "0x2060ff" }],
  });
  const look = resolveLook(lookName);
  if (tilt) look.tilt = { rotateX: 4, rotateY: -8, perspective: 2400 };
  const layout = sceneLayout({ width: 640, height: 360 }, look, 16 / 9);
  const assets = await makeLookAssets(layout, look, dir);
  let frame = Buffer.alloc(0);
  await readFrames(sceneArgs(master, layout, assets, 30), layout.sceneW * layout.sceneH * 4, (f, i) => {
    if (i === 0) frame = Buffer.from(f);
  });
  return { layout, frame };
}

describe("scene", () => {
  test("flat look: the scene is the master", async () => {
    const { layout, frame } = await firstSceneFrame("flat");
    expect([layout.sceneW, layout.sceneH]).toEqual([640, 360]);
    const [r, g, b] = pixel(frame, 640, 320, 180);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(80);
    expect(g).toBeLessThan(140);
  });

  test("hero look: window centered on the backdrop, opaque, with rounded corners", async () => {
    const { layout, frame } = await firstSceneFrame("hero");
    const w = layout.sceneW;
    const center = pixel(frame, w, Math.round(w / 2), Math.round(layout.sceneH / 2));
    expect(center[2]).toBeGreaterThan(200);
    expect(center[3]).toBe(255);
    const top = pixel(frame, w, Math.round(w / 2), 2);
    expect(Math.abs((top[0] as number) - 0x8f)).toBeLessThan(12);
    const corner = pixel(frame, w, layout.winX + 1, layout.winY + 1);
    expect(corner[2]).toBeLessThan(200);
  });

  test("tilt: the warp is applied and no black wedge appears beside the window", async () => {
    const { layout, frame } = await firstSceneFrame("hero", true);
    expect(perspectiveExpr(layout)).toContain("sense=destination");
    const beside = pixel(frame, layout.sceneW, layout.winX - 4, layout.winY + 20);
    expect(beside[0]).toBeGreaterThan(40);
  });

  test("untilted layouts have no perspective expression", () => {
    expect(perspectiveExpr(sceneLayout({ width: 640, height: 360 }, LOOKS.flat, 16 / 9))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/scene.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/render/scene.ts`**

```ts
import { type SceneLayout, WARP_BORDER } from "../geometry.js";
import type { LookAssets } from "./assets.js";

const n = (v: number) => (Math.round(v * 100) / 100).toString();

/** The ffmpeg `perspective` filter for the layout's tilt, in WARP_BORDER-padded coordinates; null when untilted. */
export function perspectiveExpr(layout: SceneLayout): string | null {
  const [tl, tr, bl, br] = layout.quad;
  const untilted =
    tl[0] === 0 &&
    tl[1] === 0 &&
    tr[0] === layout.winW &&
    tr[1] === 0 &&
    bl[0] === 0 &&
    bl[1] === layout.winH &&
    br[0] === layout.winW &&
    br[1] === layout.winH;
  if (untilted) return null;
  const B = WARP_BORDER;
  const pts = layout.quad.map(([x, y], i) => `x${i}=${n(x + B)}:y${i}=${n(y + B)}`).join(":");
  return `perspective=${pts}:sense=destination:interpolation=cubic`;
}

/**
 * readFrames args producing RGBA scene frames: backdrop, shadow, then the masked (and warped) window.
 * With no mask (only when the window is the whole scene) the master passes straight through.
 */
export function sceneArgs(masterPath: string, layout: SceneLayout, assets: LookAssets, fps: number): string[] {
  if (!assets.mask) return ["-i", masterPath, "-an", "-vf", `fps=${fps},format=rgba`, "-pix_fmt", "rgba"];
  const B = WARP_BORDER;
  const perspective = perspectiveExpr(layout);
  const inputs = ["-i", masterPath, "-loop", "1", "-i", assets.backdrop, "-loop", "1", "-i", assets.mask];
  const graph = [
    `[0:v]fps=${fps},format=rgb24,pad=iw+${2 * B}:ih+${2 * B}:${B}:${B}:black${perspective ? `,${perspective}` : ""},format=rgba[v]`,
    "[2:v]format=gray[m]",
    "[v][m]alphamerge[w]",
    "[1:v]format=rgba[bg]",
  ];
  let base = "bg";
  if (assets.shadow) {
    inputs.push("-loop", "1", "-i", assets.shadow);
    graph.push(`[bg][3:v]overlay=${assets.shadowX}:${assets.shadowY}[bs]`);
    base = "bs";
  }
  graph.push(`[${base}][w]overlay=${layout.winX - B}:${layout.winY - B}:shortest=1,format=rgba[out]`);
  return [...inputs, "-an", "-filter_complex", graph.join(";"), "-map", "[out]", "-pix_fmt", "rgba"];
}
```

- [ ] **Step 4: Implement `src/render/assets.ts`**

```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Canvas, createCanvas, loadImage } from "@napi-rs/canvas";
import { CameraworkError } from "../errors.js";
import { runFfmpeg } from "../ffmpeg.js";
import { lookScale, type SceneLayout, WARP_BORDER } from "../geometry.js";
import type { Look } from "../schema.js";
import { perspectiveExpr } from "./scene.js";

export interface LookAssets {
  backdrop: string;
  mask: string | null;
  shadow: string | null;
  shadowX: number;
  shadowY: number;
}

const png = (path: string, canvas: Canvas) => writeFileSync(path, canvas.toBuffer("image/png"));

async function drawBackdrop(layout: SceneLayout, look: Look, path: string): Promise<void> {
  const c = createCanvas(layout.sceneW, layout.sceneH);
  const ctx = c.getContext("2d");
  const bd = look.backdrop;
  if (bd.type === "gradient") {
    const a = ((bd.angle - 90) * Math.PI) / 180; // CSS angles: 180 = top → bottom
    const half = (Math.abs(layout.sceneW * Math.cos(a)) + Math.abs(layout.sceneH * Math.sin(a))) / 2;
    const cx = layout.sceneW / 2;
    const cy = layout.sceneH / 2;
    const g = ctx.createLinearGradient(
      cx - Math.cos(a) * half,
      cy - Math.sin(a) * half,
      cx + Math.cos(a) * half,
      cy + Math.sin(a) * half,
    );
    for (const s of bd.stops) g.addColorStop(s.at, s.color);
    ctx.fillStyle = g;
  } else if (bd.type === "solid") {
    ctx.fillStyle = bd.color;
  } else {
    ctx.fillStyle = "#000000";
  }
  ctx.fillRect(0, 0, layout.sceneW, layout.sceneH);
  if (bd.type === "image") {
    let img: Awaited<ReturnType<typeof loadImage>>;
    try {
      img = await loadImage(bd.path);
    } catch {
      throw new CameraworkError(`cannot read the backdrop image ${bd.path}`);
    }
    const s = Math.max(layout.sceneW / img.width, layout.sceneH / img.height); // cover
    ctx.drawImage(img, (layout.sceneW - img.width * s) / 2, (layout.sceneH - img.height * s) / 2, img.width * s, img.height * s);
  }
  png(path, c);
}

/** Draws the backdrop, the (warped) rounded mask and the shadow once, before rendering (ruling R7). */
export async function makeLookAssets(layout: SceneLayout, look: Look, workDir: string): Promise<LookAssets> {
  const backdrop = join(workDir, "backdrop.png");
  await drawBackdrop(layout, look, backdrop);
  const k = lookScale(layout.winW);
  const radius = look.radius * k;
  const warp = perspectiveExpr(layout);
  const windowIsScene = layout.sceneW === layout.winW && layout.sceneH === layout.winH;
  // The mask also hides the WARP_BORDER around the window, so it is skipped only when the window is the scene.
  if (radius === 0 && !warp && look.shadow.opacity === 0 && windowIsScene)
    return { backdrop, mask: null, shadow: null, shadowX: 0, shadowY: 0 };

  const B = WARP_BORDER;
  const flat = createCanvas(layout.winW + 2 * B, layout.winH + 2 * B);
  const fc = flat.getContext("2d");
  fc.fillStyle = "#000000";
  fc.fillRect(0, 0, flat.width, flat.height);
  fc.fillStyle = "#ffffff";
  fc.beginPath();
  fc.roundRect(B, B, layout.winW, layout.winH, radius);
  fc.fill();
  const flatMask = join(workDir, "mask-flat.png");
  png(flatMask, flat);
  const mask = join(workDir, "mask.png");
  await runFfmpeg(["-i", flatMask, "-vf", warp ? `format=gray,${warp}` : "format=gray", "-frames:v", "1", mask]);

  if (look.shadow.opacity === 0) return { backdrop, mask, shadow: null, shadowX: 0, shadowY: 0 };
  const blur = look.shadow.blur * k;
  const S = Math.ceil(blur * 2) + 2;
  const shadow = join(workDir, "shadow.png");
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=black:size=${layout.winW + 2 * B + 2 * S}x${layout.winH + 2 * B + 2 * S}`,
    "-i",
    mask,
    "-filter_complex",
    `[1:v]format=gray,pad=iw+${2 * S}:ih+${2 * S}:${S}:${S}:black,gblur=sigma=${Math.max(0.5, blur / 2)}[a];` +
      `[0:v]format=rgba[b];[b][a]alphamerge,colorchannelmixer=aa=${look.shadow.opacity}`,
    "-frames:v",
    "1",
    shadow,
  ]);
  return {
    backdrop,
    mask,
    shadow,
    shadowX: layout.winX - B - S,
    shadowY: Math.round(layout.winY - B - S + look.shadow.offsetY * k),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/scene.test.ts && bunx tsc --noEmit && bunx biome check .`
Expected: 4 pass; clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: look assets (backdrop, warped mask, shadow) and the ffmpeg scene graph"
```

---

### Task 12: Camera, encoders and `render()`

**Files:**
- Create: `src/render/encode.ts`, `src/render/camera.ts`, `src/render/index.ts`, `test/encode.test.ts`, `test/render.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `Plan`; `sceneLayout`; `makeLookAssets`, `sceneArgs` (Task 11); `readFrames`, `FrameSink`, `hasEncoder`, `requireFfmpeg` (Task 3); `cameraAt` (Task 8); `CameraworkError`.
- Produces:
  - `pickWebmCodec(): "av1" | "vp9"`; `encoderArgs(format: "mp4" | "webm", width: number, height: number, fps: number, out: string, codec?: "av1" | "vp9"): string[]` (raw RGBA on stdin).
  - `class Camera { constructor(sceneW, sceneH, outW, outH, quality: "medium" | "high"); frame(scene: Buffer, view: View): Buffer; encode(format: "jpg" | "webp"): Buffer }` — `frame` returns a **copy** of opaque RGBA `outW × outH`.
  - `checkSharpness(plan: Plan): void`; `interface RenderOptions { out: string; onProgress?: (done: number, total: number) => void }`; `render(plan: Plan, opts: RenderOptions): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

`test/encode.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { encoderArgs } from "../src/render/encode.js";

const raw = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1920x1080", "-r", "30", "-i", "-"];

describe("encoderArgs", () => {
  test("mp4 is H.264, slow, crf 20, yuv420p, faststart", () => {
    expect(encoderArgs("mp4", 1920, 1080, 30, "o.mp4")).toEqual([
      ...raw,
      ...["-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
      ...["-f", "mp4", "o.mp4"],
    ]);
  });

  test("webm is SVT-AV1 crf 32 preset 6, or VP9 crf 32", () => {
    expect(encoderArgs("webm", 1920, 1080, 30, "o.webm", "av1")).toEqual([
      ...raw,
      ...["-c:v", "libsvtav1", "-crf", "32", "-preset", "6", "-pix_fmt", "yuv420p", "-f", "webm", "o.webm"],
    ]);
    expect(encoderArgs("webm", 1920, 1080, 30, "o.webm", "vp9")).toEqual([
      ...raw,
      ...["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-pix_fmt", "yuv420p", "-f", "webm", "o.webm"],
    ]);
  });
});
```

`test/render.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CameraworkError } from "../src/errors.js";
import { probe, readFrames } from "../src/ffmpeg.js";
import { plan } from "../src/plan/index.js";
import { checkSharpness, render } from "../src/render/index.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

/** Centroid of strongly red pixels in the output frame at time t. */
async function redCentroid(video: string, t: number, w: number, h: number): Promise<[number, number]> {
  let result: [number, number] = [-1, -1];
  await readFrames(["-ss", String(t), "-i", video, "-frames:v", "1", "-pix_fmt", "rgb24"], w * h * 3, (f) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        if ((f[i] as number) > 150 && (f[i + 1] as number) < 90 && (f[i + 2] as number) < 90) {
          sx += x;
          sy += y;
          n++;
        }
      }
    result = n ? [sx / n, sy / n] : [-1, -1];
  });
  return result;
}

describe("render (end to end)", () => {
  test("the camera centers each box while it holds on it (Review Focus 5: paths with spaces)", async () => {
    const dir = tmpDir("camerawork e2e ");
    const master = join(dir, "boxes master.mp4");
    // Boxes sit away from the edges: at zoom 2 the camera cannot center anything within 320×180 px of an edge.
    await makeBoxVideo(master, {
      width: 1280,
      height: 720,
      fps: 30,
      seconds: 8,
      boxes: [
        { x: 400, y: 250, size: 80, from: 1, to: 3.6 },
        { x: 800, y: 400, size: 80, from: 4.5, to: 8 },
      ],
    });
    const p = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4"], poster: "jpg" }, loop: true });
    const files = await render(p, { out: join(dir, "out clip") });
    expect(files.sort()).toEqual([join(dir, "out clip.jpg"), join(dir, "out clip.mp4")]);
    const info = probe(join(dir, "out clip.mp4"));
    expect([info.width, info.height]).toEqual([640, 360]);
    expect(info.duration).toBeCloseTo(8, 0);
    // 2.6 s: holding on box 1. 5.5 s: holding on box 2 (the loop's return to wide starts at ~6.3 s).
    for (const t of [2.6, 5.5]) {
      const [cx, cy] = await redCentroid(join(dir, "out clip.mp4"), t, 640, 360);
      expect(Math.abs(cx - 320)).toBeLessThan(64);
      expect(Math.abs(cy - 180)).toBeLessThan(48);
    }
    expect(readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  test("a hand-edited plan that would upscale is refused before rendering", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const p = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4"], poster: null } });
    (p.keyframes[0] as (typeof p.keyframes)[number]).zoom = 2;
    expect(() => checkSharpness(p)).toThrow(CameraworkError);
    await expect(render(p, { out: join(dir, "o") })).rejects.toThrow("would upscale");
    expect(existsSync(join(dir, "o.mp4"))).toBe(false);
  });

  test("maxBytes fails the render and leaves no file", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, {
      width: 640,
      height: 360,
      fps: 30,
      seconds: 2,
      boxes: [{ x: 10, y: 10, size: 50, from: 0.5, to: 2 }],
    });
    const p = await plan(master, { look: "flat", output: { width: 640, formats: ["mp4"], poster: null, maxBytes: 100 } });
    await expect(render(p, { out: join(dir, "o") })).rejects.toThrow("larger than the 100-byte limit");
    expect(existsSync(join(dir, "o.mp4"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/encode.test.ts test/render.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/render/encode.ts`**

```ts
import { hasEncoder } from "../ffmpeg.js";

export const pickWebmCodec = (): "av1" | "vp9" => (hasEncoder("libsvtav1") ? "av1" : "vp9");

/** ffmpeg args that read raw RGBA frames on stdin and encode one web format (spec §6.2). */
export function encoderArgs(
  format: "mp4" | "webm",
  width: number,
  height: number,
  fps: number,
  out: string,
  codec: "av1" | "vp9" = "av1",
): string[] {
  const input = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "-"];
  if (format === "mp4")
    return [
      ...input,
      ...["-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
      ...["-f", "mp4", out],
    ];
  if (codec === "av1")
    return [...input, "-c:v", "libsvtav1", "-crf", "32", "-preset", "6", "-pix_fmt", "yuv420p", "-f", "webm", out];
  return [
    ...input,
    ...["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-pix_fmt", "yuv420p", "-f", "webm", out],
  ];
}
```

- [ ] **Step 4: Implement `src/render/camera.ts`**

```ts
import { type Canvas, createCanvas, ImageData, type SKRSContext2D } from "@napi-rs/canvas";
import type { View } from "../schema.js";

/**
 * Applies a camera view to scene frames with Skia: sub-pixel transform, mipmapped bilinear ("medium") or cubic
 * ("high") resampling (ruling R4). Output is opaque, so Skia's premultiplied pixels equal straight RGBA.
 */
export class Camera {
  private readonly src: Canvas;
  private readonly sctx: SKRSContext2D;
  private readonly out: Canvas;
  private readonly octx: SKRSContext2D;

  constructor(
    private readonly sceneW: number,
    private readonly sceneH: number,
    private readonly outW: number,
    private readonly outH: number,
    quality: "medium" | "high",
  ) {
    this.src = createCanvas(sceneW, sceneH);
    this.sctx = this.src.getContext("2d");
    this.out = createCanvas(outW, outH);
    this.octx = this.out.getContext("2d");
    this.octx.imageSmoothingEnabled = true;
    this.octx.imageSmoothingQuality = quality;
  }

  frame(scene: Buffer, view: View): Buffer {
    const pixels = new Uint8ClampedArray(scene.buffer, scene.byteOffset, scene.length);
    this.sctx.putImageData(new ImageData(pixels, this.sceneW, this.sceneH), 0, 0);
    const s = (this.outW / this.sceneW) * view.zoom;
    const vw = this.sceneW / view.zoom;
    const vh = this.sceneH / view.zoom;
    const cx = Math.min(this.sceneW - vw / 2, Math.max(vw / 2, view.cx));
    const cy = Math.min(this.sceneH - vh / 2, Math.max(vh / 2, view.cy));
    this.octx.setTransform(1, 0, 0, 1, 0, 0);
    this.octx.fillStyle = "#000000";
    this.octx.fillRect(0, 0, this.outW, this.outH);
    this.octx.setTransform(s, 0, 0, s, this.outW / 2 - cx * s, this.outH / 2 - cy * s);
    this.octx.drawImage(this.src, 0, 0);
    // A copy: stream writes keep a reference until flushed, and the canvas memory is reused for the next frame.
    return Buffer.from(this.out.data());
  }

  /** The current output frame as an encoded poster image. */
  encode(format: "jpg" | "webp"): Buffer {
    return format === "jpg" ? this.out.toBuffer("image/jpeg", 90) : this.out.toBuffer("image/webp", 90);
  }
}
```

- [ ] **Step 5: Implement `src/render/index.ts`**

```ts
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CameraworkError } from "../errors.js";
import { FrameSink, readFrames, requireFfmpeg } from "../ffmpeg.js";
import { sceneLayout } from "../geometry.js";
import { cameraAt } from "../plan/interp.js";
import type { Plan } from "../schema.js";
import { makeLookAssets } from "./assets.js";
import { Camera } from "./camera.js";
import { encoderArgs, pickWebmCodec } from "./encode.js";
import { sceneArgs } from "./scene.js";

export interface RenderOptions {
  /** Output prefix: files are written as `<out>.mp4`, `<out>.webm`, `<out>.jpg|webp`. */
  out: string;
  onProgress?: (done: number, total: number) => void;
}

/** Refuses any plan that would upscale (spec §6.3, ruling R5). */
export function checkSharpness(plan: Plan): void {
  const deepest = Math.max(1, ...plan.keyframes.map((k) => k.zoom));
  if (plan.output.width * deepest > plan.scene.width + 1e-6 || deepest > plan.maxZoom + 1e-6)
    throw new CameraworkError(
      `zoom ${deepest.toFixed(2)} at ${plan.output.width} px would upscale the ${plan.scene.width}-px scene. ` +
        `Keep zoom at or below ${(plan.scene.width / plan.output.width).toFixed(2)}, lower the output width, ` +
        "or record a bigger master.",
    );
}

const even = (n: number) => Math.round(n / 2) * 2;

/** Renders a plan: scene (ffmpeg) → camera (Skia) → encoders, all streaming; files appear only on success. */
export async function render(plan: Plan, opts: RenderOptions): Promise<string[]> {
  requireFfmpeg();
  checkSharpness(plan);
  const layout = sceneLayout(plan.master, plan.look, plan.output.aspect);
  if (layout.sceneW !== plan.scene.width || layout.sceneH !== plan.scene.height)
    throw new CameraworkError("the plan's scene size does not match its look and master; re-run plan");
  const outW = plan.output.width;
  const outH = even(outW / plan.output.aspect);
  const work = mkdtempSync(join(tmpdir(), "camerawork-"));
  const tmp = (ext: string) => `${opts.out}.tmp-${process.pid}.${ext}`;
  const written: [string, string][] = [];
  try {
    const assets = await makeLookAssets(layout, plan.look, work);
    const codec = pickWebmCodec();
    const sinks = plan.output.formats.map((format) => {
      const path = tmp(format);
      written.push([path, `${opts.out}.${format}`]);
      return new FrameSink(encoderArgs(format, outW, outH, plan.output.fps, path, codec));
    });
    const camera = new Camera(layout.sceneW, layout.sceneH, outW, outH, plan.output.quality);
    const total = Math.round(plan.master.duration * plan.output.fps);
    await readFrames(
      sceneArgs(plan.master.path, layout, assets, plan.output.fps),
      layout.sceneW * layout.sceneH * 4,
      async (scene, i) => {
        const frame = camera.frame(scene, cameraAt(plan.keyframes, i / plan.output.fps));
        if (i === 0 && plan.output.poster) {
          const path = tmp(plan.output.poster);
          writeFileSync(path, camera.encode(plan.output.poster));
          written.push([path, `${opts.out}.${plan.output.poster}`]);
        }
        await Promise.all(sinks.map((s) => s.write(frame)));
        opts.onProgress?.(i + 1, total);
      },
    );
    await Promise.all(sinks.map((s) => s.end()));
    if (plan.output.maxBytes !== null)
      for (const [path, final] of written) {
        const size = statSync(path).size;
        if (size > plan.output.maxBytes)
          throw new CameraworkError(
            `${final} is ${size} bytes, larger than the ${plan.output.maxBytes}-byte limit. ` +
              "Lower the width or fps, or raise maxBytes.",
          );
      }
    for (const [path, final] of written) renameSync(path, final);
    return written.map(([, final]) => final);
  } catch (error) {
    for (const [path] of written) rmSync(path, { force: true });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
```

- [ ] **Step 6: Export**

In `src/index.ts`, add:
```ts
export { checkSharpness, type RenderOptions, render } from "./render/index.js";
```

- [ ] **Step 7: Run the tests**

Run: `bun test test/encode.test.ts test/render.test.ts && bunx tsc --noEmit && bunx biome check .`
Expected: all pass. If the centroid assertion fails, print `p.shots` and `p.keyframes` to locate the fault (detection, planning or rendering) and fix the cause with superpowers:systematic-debugging; never widen the tolerance.

- [ ] **Step 8: Measure render speed and record it**

Run (one-off, not a test; skip it on machines without this master — any 4K master works):
```bash
bun -e '
import { plan } from "./src/plan/index.ts"; import { render } from "./src/render/index.ts";
const m = "/Volumes/Content/projects/JSLab Website/assets/video/masters/palette-loop.mov";
const p = await plan(m, { look: "hero", loop: true, output: { width: 1920, formats: ["mp4"], poster: null } });
const t0 = performance.now(); await render(p, { out: "/tmp/camerawork-speed" });
console.log(`${p.master.duration.toFixed(1)} s video rendered in ${((performance.now() - t0) / 1000).toFixed(1)} s`);'
```
Expected: one line with both durations. Ledger it: `Task 12: Ruling: measured speed <ratio>× real time on <machine> (spec estimated 1–3×)`.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: render() — Skia camera over the ffmpeg scene into mp4/webm/poster, with guards"
```

---

### Task 13: Preview

**Files:**
- Create: `src/preview.ts`, `test/preview.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `Plan`, `sceneLayout`, `makeLookAssets`, `sceneArgs`, `readFrames`, `FrameSink`, `encoderArgs`, `cameraAt`.
- Produces: `interface PreviewOptions { out: string; every?: number /* default 0.5 */; columns?: number /* 6 */; tileWidth?: number /* 480 */; debugWidth?: number /* 960 */ }`; `preview(plan: Plan, opts: PreviewOptions): Promise<{ sheet: string; debug: string }>` → `<out>-sheet.png`, `<out>-debug.mp4`.

- [ ] **Step 1: Write the failing test**

`test/preview.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { probe } from "../src/ffmpeg.js";
import { plan } from "../src/plan/index.js";
import { preview } from "../src/preview.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

describe("preview", () => {
  test("writes a contact sheet (6 columns of 480 px) and a 960-px debug video", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, {
      width: 1280,
      height: 720,
      fps: 30,
      seconds: 3,
      boxes: [{ x: 500, y: 300, size: 80, from: 1, to: 3 }],
    });
    const p = await plan(master, { look: "hero", output: { width: 640 } });
    const { sheet, debug } = await preview(p, { out: join(dir, "plan") });
    const img = await loadImage(sheet);
    expect(img.width).toBe(6 * 480);
    expect(img.height).toBeGreaterThan(0);
    expect(probe(debug).width).toBe(960);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/preview.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/preview.ts`**

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { FrameSink, readFrames, requireFfmpeg } from "./ffmpeg.js";
import { sceneLayout } from "./geometry.js";
import { cameraAt } from "./plan/interp.js";
import { makeLookAssets } from "./render/assets.js";
import { encoderArgs } from "./render/encode.js";
import { sceneArgs } from "./render/scene.js";
import type { Plan } from "./schema.js";

export interface PreviewOptions {
  out: string;
  every?: number;
  columns?: number;
  tileWidth?: number;
  debugWidth?: number;
}

const even = (n: number) => Math.round(n / 2) * 2;

/** Scales the scene graph's output to the debug size (works for both the -vf and the -filter_complex form). */
function scaled(args: string[], w: number, h: number): string[] {
  return args.map((a, i) => {
    if (args[i - 1] === "-vf") return `${a},scale=${w}:${h}`;
    if (args[i - 1] === "-filter_complex") return a.replace("format=rgba[out]", `format=rgba,scale=${w}:${h}[out]`);
    return a;
  });
}

/** A contact sheet and a debug video showing the camera's frame (yellow), auto shots (red) and cues (cyan). */
export async function preview(plan: Plan, opts: PreviewOptions): Promise<{ sheet: string; debug: string }> {
  requireFfmpeg();
  const every = opts.every ?? 0.5;
  const columns = opts.columns ?? 6;
  const tileW = opts.tileWidth ?? 480;
  const debugW = opts.debugWidth ?? 960;
  const layout = sceneLayout(plan.master, plan.look, plan.output.aspect);
  const work = mkdtempSync(join(tmpdir(), "camerawork-preview-"));
  try {
    const assets = await makeLookAssets(layout, plan.look, work);
    const fps = plan.output.fps;
    const k = debugW / layout.sceneW;
    const dH = even(layout.sceneH * k);
    const tileH = Math.round((tileW / debugW) * dH);
    const tiles = Math.max(1, Math.ceil(plan.master.duration / every));
    const sheetCanvas = createCanvas(columns * tileW, Math.ceil(tiles / columns) * tileH);
    const sctx = sheetCanvas.getContext("2d");
    const frameCanvas = createCanvas(debugW, dH);
    const fctx = frameCanvas.getContext("2d");
    const debugPath = `${opts.out}-debug.mp4`;
    const sink = new FrameSink(encoderArgs("mp4", debugW, dH, fps, debugPath));
    let nextTile = 0;
    await readFrames(scaled(sceneArgs(plan.master.path, layout, assets, fps), debugW, dH), debugW * dH * 4, async (frame, i) => {
      const t = i / fps;
      fctx.putImageData(new ImageData(new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.length), debugW, dH), 0, 0);
      const v = cameraAt(plan.keyframes, t);
      const vw = (layout.sceneW / v.zoom) * k;
      const vh = (layout.sceneH / v.zoom) * k;
      fctx.lineWidth = 3;
      fctx.strokeStyle = "#ffcc00";
      fctx.strokeRect(v.cx * k - vw / 2, v.cy * k - vh / 2, vw, vh);
      for (const [n, s] of plan.shots.entries()) {
        if (t < s.start - 0.05 || t > s.end + 0.05) continue;
        fctx.strokeStyle = s.source === "cue" ? "#33ddff" : "#ff4466";
        fctx.lineWidth = 2;
        fctx.strokeRect(s.rect[0] * k, s.rect[1] * k, s.rect[2] * k, s.rect[3] * k);
        fctx.fillStyle = "#ffffff";
        fctx.font = "18px sans-serif";
        fctx.fillText(`#${n + 1}`, s.rect[0] * k, Math.max(18, s.rect[1] * k - 4));
      }
      fctx.fillStyle = "rgba(0,0,0,0.6)";
      fctx.fillRect(0, 0, 96, 30);
      fctx.fillStyle = "#ffffff";
      fctx.font = "20px sans-serif";
      fctx.fillText(`${t.toFixed(1)} s`, 8, 22);
      if (t + 1e-6 >= nextTile * every && nextTile < tiles) {
        sctx.drawImage(frameCanvas, (nextTile % columns) * tileW, Math.floor(nextTile / columns) * tileH, tileW, tileH);
        nextTile++;
      }
      await sink.write(Buffer.from(frameCanvas.data())); // copied: the canvas is redrawn next frame
    });
    await sink.end();
    const sheetPath = `${opts.out}-sheet.png`;
    writeFileSync(sheetPath, sheetCanvas.toBuffer("image/png"));
    return { sheet: sheetPath, debug: debugPath };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Export**

In `src/index.ts`, add:
```ts
export { type PreviewOptions, preview } from "./preview.js";
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/preview.test.ts && bunx tsc --noEmit && bunx biome check .`
Expected: pass; clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: preview() contact sheet and debug video"
```

---

### Task 14: CLI

**Files:**
- Create: `src/cli.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `detect`, `plan`, `readJson`, `readCueFile`, `readChangesFile`, `readPlan`, `writeJsonAtomic`, `preview`, `render`, `CameraworkError`.
- Produces: the `camerawork` binary: `detect`, `plan`, `preview`, `render`, `--version`, `--help`. Exit 0 on success; 1 with `camerawork: <message>` on a `CameraworkError`; 2 with usage on a usage error.

- [ ] **Step 1: Write the failing tests**

`test/cli.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBoxVideo, tmpDir } from "./helpers.js";

const cli = (...args: string[]) =>
  spawnSync("bun", [join(import.meta.dir, "../src/cli.ts"), ...args], { encoding: "utf8" });

describe("cli", () => {
  test("--version prints the package version", () => {
    const r = cli("--version");
    expect(r.status).toBe(0);
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { version: string };
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  test("plan → render writes the files", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, {
      width: 1280,
      height: 720,
      fps: 30,
      seconds: 3,
      boxes: [{ x: 500, y: 300, size: 80, from: 1, to: 3 }],
    });
    const planPath = join(dir, "plan.json");
    const planned = cli("plan", master, "-o", planPath, "--look", "flat", "--width", "640", "--formats", "mp4", "--poster", "none", "--loop");
    expect(planned.status).toBe(0);
    expect(cli("render", planPath, "-o", join(dir, "clip")).status).toBe(0);
    expect(existsSync(join(dir, "clip.mp4"))).toBe(true);
  });

  test("a CameraworkError exits 1 with a camerawork: prefix", () => {
    const r = cli("plan", "/nope/missing.mov", "-o", "/tmp/x.json");
    expect(r.status).toBe(1);
    expect(r.stderr).toStartWith("camerawork: cannot read /nope/missing.mov");
  });

  test("an unknown command exits 2 with usage", () => {
    const r = cli("frobnicate");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Usage:");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/cli.test.ts`
Expected: FAIL — `src/cli.ts` not found.

- [ ] **Step 3: Implement `src/cli.ts`**

```ts
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { detect } from "./detect/index.js";
import { CameraworkError } from "./errors.js";
import { plan, readChangesFile, readCueFile, readJson, readPlan, writeJsonAtomic } from "./plan/index.js";
import { preview } from "./preview.js";
import { render } from "./render/index.js";
import type { Look, Rect } from "./schema.js";

const USAGE = `Usage:
  camerawork detect <master> -o <changes.json> [--mask x,y,w,h]...
  camerawork plan <master> -o <plan.json> [--cues f] [--changes f] [--look hero|flat|look.json] [--loop]
                  [--width N] [--fps N] [--formats mp4,webm] [--poster jpg|webp|none] [--max-bytes N]
                  [--quality medium|high] [--max-zoom N] [--min-hold N] [--mask x,y,w,h]...
  camerawork preview <plan.json> [-o <prefix>]
  camerawork render <plan.json> -o <prefix>
  camerawork --version`;

class UsageError extends Error {}

const version = (): string => {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
};

const num = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${v}"`);
  return n;
};

const rect = (v: string): Rect => {
  const parts = v.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw new UsageError(`--mask must be x,y,w,h, got "${v}"`);
  return parts as Rect;
};

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      mask: { type: "string", multiple: true },
      cues: { type: "string" },
      changes: { type: "string" },
      look: { type: "string" },
      loop: { type: "boolean" },
      width: { type: "string" },
      fps: { type: "string" },
      formats: { type: "string" },
      poster: { type: "string" },
      "max-bytes": { type: "string" },
      quality: { type: "string" },
      "max-zoom": { type: "string" },
      "min-hold": { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version) {
    console.log(version());
    return;
  }
  const [command, input] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const need = (v: string | undefined, what: string): string => {
    if (!v) throw new UsageError(`${command} needs ${what}`);
    return v;
  };
  const masks = (values.mask ?? []).map(rect);
  switch (command) {
    case "detect": {
      const changes = await detect(need(input, "a master video"), { masks });
      writeJsonAtomic(need(values.out, "-o <changes.json>"), changes);
      console.log(`${changes.changes.length} changes → ${values.out}`);
      return;
    }
    case "plan": {
      const look = values.look?.endsWith(".json") ? (readJson(values.look) as Look) : values.look;
      const poster = values.poster === "none" ? null : values.poster;
      const p = await plan(need(input, "a master video"), {
        cues: values.cues ? readCueFile(values.cues) : undefined,
        changes: values.changes ? readChangesFile(values.changes) : undefined,
        look,
        loop: values.loop ?? false,
        masks,
        output: defined({
          width: num("width", values.width),
          fps: num("fps", values.fps),
          formats: values.formats?.split(","),
          poster,
          maxBytes: num("max-bytes", values["max-bytes"]),
          quality: values.quality,
        }),
        planner: defined({ maxZoom: num("max-zoom", values["max-zoom"]), minHold: num("min-hold", values["min-hold"]) }),
      });
      writeJsonAtomic(need(values.out, "-o <plan.json>"), p);
      console.log(`${p.shots.length} shots, ${p.keyframes.length} keyframes, max zoom ${p.maxZoom.toFixed(2)} → ${values.out}`);
      return;
    }
    case "preview": {
      const planPath = need(input, "a plan.json");
      const { sheet, debug } = await preview(readPlan(planPath), { out: values.out ?? planPath.replace(/\.json$/, "") });
      console.log(`${sheet}\n${debug}`);
      return;
    }
    case "render": {
      const files = await render(readPlan(need(input, "a plan.json")), {
        out: need(values.out, "-o <prefix>"),
        onProgress: (done, total) => {
          if (process.stderr.isTTY) process.stderr.write(`\rrendering ${done}/${total}`);
        },
      });
      if (process.stderr.isTTY) process.stderr.write("\n");
      console.log(files.join("\n"));
      return;
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CameraworkError) {
    console.error(`camerawork: ${error.message}`);
    process.exit(1);
  }
  if (error instanceof UsageError || String((error as { code?: string }).code).startsWith("ERR_PARSE_ARGS")) {
    console.error(`camerawork: ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
```

(The `output` and `planner` objects are validated inside `plan()` by their zod schemas, so a bad `--formats` or `--quality` value becomes a `CameraworkError` naming the field.)

- [ ] **Step 4: Run the tests and build**

Run: `bun test test/cli.test.ts && bun run build && node dist/cli.js --version && bunx biome check .`
Expected: 4 pass; `0.1.0`; clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: camerawork CLI (detect, plan, preview, render)"
```

---

### Task 15: Skill, README, release readiness

**Files:**
- Create: `skills/camerawork/SKILL.md`, `test/docs.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the CLI (Task 14).
- Produces: the skill (frontmatter `name: camerawork`, `description: …`) and the full README.

- [ ] **Step 1: Write the failing test**

`test/docs.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("docs", () => {
  test("the skill has frontmatter and covers the workflow and every CLI command", () => {
    const skill = readFileSync(join(root, "skills/camerawork/SKILL.md"), "utf8");
    expect(skill).toStartWith("---\nname: camerawork\ndescription: ");
    for (const word of ["camerawork plan", "camerawork preview", "camerawork render", "contact sheet", "cues.json", "--mask"])
      expect(skill).toContain(word);
  });

  test("the README documents install, the skill link and every command", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    for (const word of [
      "npm install -g camerawork",
      "~/.claude/skills",
      "camerawork detect",
      "camerawork plan",
      "camerawork preview",
      "camerawork render",
      "ffmpeg",
    ])
      expect(readme).toContain(word);
    expect(readme).not.toContain("in design");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/docs.test.ts`
Expected: FAIL — `skills/camerawork/SKILL.md` not found.

- [ ] **Step 3: Write `skills/camerawork/SKILL.md`**

````markdown
---
name: camerawork
description: Use when turning a screen recording into a guided product video (zoom and pan to what changes, on a backdrop with a rounded window), or re-rendering a site's demo videos. Runs the camerawork CLI, checks the plan visually, and fixes it with cues or masks.
---

# camerawork: guided video tours from screen recordings

camerawork finds where a recording changes, plans a calm camera that zooms and pans to each change, and renders it
with a presentation look. Requires `camerawork` (`npm install -g camerawork`) and ffmpeg 6+ on PATH.

## Workflow

1. **Get a master.** A high-resolution recording, ideally twice the output width (a 3840-px master for a 1920-px
   video); deeper zooms need more pixels. Scripted captures are best; hand recordings work too.
2. **Plan.** `camerawork plan master.mov -o plan.json --look hero --loop` (add `--cues cues.json` if the capture
   wrote one; `--loop` for website loops). It prints the shot count and the effective max zoom.
3. **Preview.** `camerawork preview plan.json` writes `plan-sheet.png` (the contact sheet: one tile per 0.5 s;
   yellow = camera, red = detected change, cyan = cue) and `plan-debug.mp4`.
4. **Read the contact sheet** (open the PNG and look at it). Check that:
   - every important moment is inside the yellow box when it happens (typing, a result, a panel opening);
   - nothing important is cut off at the box's edge;
   - the camera is not chasing noise (a spinner, a clock, a blinking cursor);
   - a loop rests wide at its start and end.
5. **Fix**, then plan and preview again:
   - camera chases noise → `--mask x,y,w,h` (master pixels) or `"masks"` in cues.json;
   - too twitchy → `--min-hold 2`;
   - too zoomed (text too big) → `--max-zoom 1.6`;
   - misses the important part → add a cue (below);
   - a stretch should be ignored → an ignore cue.
6. **Render.** `camerawork render plan.json -o public/videos/feature` writes `feature.mp4`, `feature.webm` and
   `feature.jpg`. Then look at the poster and a couple of frames
   (`ffmpeg -ss 3 -i feature.mp4 -frames:v 1 frame.png`).

`plan.json` is the source of truth: edit its keyframes or look and run `render` again without re-planning.

## cues.json

```json
{ "version": 1,
  "masks": [[3700, 0, 140, 40]],
  "planner": { "maxZoom": 2 },
  "cues": [
    { "t": 3.2, "rect": [1083, 26, 261, 57], "zoom": 2.0, "hold": 1.5, "label": "filter chips" },
    { "t": 8.0, "wide": true },
    { "from": 5.0, "to": 6.0, "ignore": true } ] }
```

Times are seconds from the master's first frame; rects are master pixels `[x, y, w, h]`. A cue wins over detection
inside its window. From a capture script: time cues from the moment recording actually started, and convert element
rectangles (window points) to master pixels by multiplying by the display's backing scale.

## Looks

`--look hero` (gradient backdrop, 9 % padding, rounded corners, shadow), `--look flat` (the window alone), or
`--look my-look.json` (any look object; `backdrop` can be `{ "type": "image", "path": "bg.jpg" }`).

## Errors worth knowing

- "would upscale": the master is too small for that output width at that zoom → lower `--width` or `--max-zoom`, or
  record a bigger master.
- "larger than the …-byte limit": lower `--width` or `--fps`, or raise `--max-bytes`.
````

- [ ] **Step 4: Rewrite `README.md`**

````markdown
# camerawork

Turn a high-resolution screen recording into a guided video tour. camerawork finds where the screen changes, plans
a calm camera path that zooms and pans to each change (optionally steered by cues from a capture script), and
renders it with a presentation look (backdrop, rounded corners, shadow, optional tilt) into web-ready mp4, webm and
a poster.

## Install

```bash
npm install -g camerawork
```

Requires **ffmpeg and ffprobe 6+** on PATH (macOS: `brew install ffmpeg`; Debian/Ubuntu: `sudo apt install ffmpeg`)
and Node 20+ (or Bun 1.4+).

## Use

```bash
camerawork detect master.mov -o changes.json                       # optional: just the detected changes
camerawork plan master.mov -o plan.json --look hero --loop [--cues cues.json]
camerawork preview plan.json                                        # plan-sheet.png + plan-debug.mp4
camerawork render plan.json -o out/feature                          # out/feature.mp4, .webm, .jpg
```

`camerawork --help` lists every flag. `plan.json` is the source of truth: edit it and run `render` again.

## Library

```ts
import { plan, render } from "camerawork";

const p = await plan("master.mov", { look: "hero", loop: true, output: { width: 1920 } });
await render(p, { out: "out/feature" });
```

## Claude skill

The package ships a Claude skill that runs the whole workflow, including checking the contact sheet:

```bash
ln -s "$(npm root -g)/camerawork/skills/camerawork" ~/.claude/skills/camerawork
```

## How it works

See [the design](docs/superpowers/specs/2026-10-17-camerawork-design.md): change detection by frame differencing,
shot clustering and a capped, eased camera path, then ffmpeg (scene) → Skia (camera) → ffmpeg (encode).

MIT licensed.
````

- [ ] **Step 5: Run the full suite, lint, typecheck, build**

Run: `bun test && bunx biome check . && bunx tsc --noEmit && bun run build && node dist/cli.js --help`
Expected: every test passes; clean; the usage text prints.

- [ ] **Step 6: Commit, push, check CI**

```bash
git add -A && git commit -m "docs: the camerawork skill and README"
git push
gh run watch --exit-status
```
Expected: CI green on macOS and Linux.

- [ ] **Step 7: Make it available locally (no publish)**

```bash
bun run build && npm link && camerawork --version
ln -sfn /Volumes/Content/projects/camerawork/skills/camerawork ~/.claude/skills/camerawork
```
Expected: `0.1.0`; the skill link exists. Publishing to npm is an **owner step** (it needs the owner's npm login and is
outward-facing): hand over `npm login && npm publish --access public`; do not run it.
