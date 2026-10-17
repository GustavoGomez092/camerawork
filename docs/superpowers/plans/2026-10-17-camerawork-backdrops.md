# camerawork Backdrops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Procedural shader backdrops (9 styles, 16 presets, optional seamless motion) usable from look files and `--look <preset>`, plus `camerawork looks`, `camerawork look preview` and a local look editor (`camerawork look edit`).

**Architecture:** Each style is a pure, seeded, periodic `shade(u, v, t, p)` function in `src/backdrops/` (browser-safe TypeScript, no Node imports). Node renders a backdrop at a reduced field size (≤ 1280 px), upscales it with Skia and adds grain at full size (stills → `backdrop.png`); animated backdrops render one loop of field-sized frames on worker threads into an intermediate video that the existing ffmpeg scene graph loops, upscales and grains. The editor is a `node:http` server on 127.0.0.1 plus a single page bundled by esbuild from the same `src/backdrops/` and `src/geometry.ts` code.

**Tech Stack:** TypeScript (ESM, `nodenext`), Node ≥ 20 and Bun ≥ 1.4, `@napi-rs/canvas` 1.0.11 (Skia), `zod` 4, ffmpeg/ffprobe ≥ 6 (`libx264rgb`, `noise`, `-stream_loop`), `node:worker_threads`, `node:http`, esbuild **0.28.2** (dev dependency only), `bun test`, Biome 2.

**Spec:** `docs/superpowers/specs/2026-10-17-camerawork-backdrops-design.md` (engine context: `docs/superpowers/specs/2026-10-17-camerawork-design.md`)

## Global Constraints

- License MIT. Runtime dependencies stay **only** `@napi-rs/canvas` and `zod`. esbuild is a **devDependency** pinned to `0.28.2`; the package ships the built page in `dist/editor/`. "No new runtime dependencies; the published package stays small; Node ≥ 20 and Bun still work."
- Source under `src/` uses only `node:` built-ins plus the two dependencies: **no Bun APIs** in `src/`, `editor/` or `scripts/build-editor.mjs`. Tests may use `bun:test`.
- ESM with explicit `.js` extensions on relative imports (`import { x } from "./schema.js"`), also in `editor/` (esbuild maps them to `.ts`).
- `src/backdrops/**` and `src/geometry.ts` are bundled into the browser page: they must not import any `node:` module and may import `../schema.js` **only with `import type`** (zod must not reach the bundle).
- Every user-facing error is a `CameraworkError` whose message says what to change; the CLI prints `camerawork: <message>` and exits 1; usage errors exit 2.
- Output files (PNGs, look files, videos) are written to a temporary name and renamed only on success.
- Determinism: same look file → same pixels. No `Math.random` anywhere in `src/` (the editor's Shuffle button is the only randomness, and it only picks a seed). All randomness comes from a seeded hash of `seed` and coordinates.
- Styles are pure `shade(u, v, t, p)` functions, periodic in `t` (every time term is sin/cos of `2πt·k`, `k` a whole number), and mix colours in **OKLab**. `u, v` are aspect-corrected (the short side spans 0–1).
- Shared settings, exactly (spec §2): `colors` 2–5 `#rrggbb` (style-specific default); `angle` 0–360 (45); `scale` 0.2–5 (1); `distortion` 0–1 (0.3); `seed` integer (1); `grain` 0–0.3 (0.04); `vignette` 0–1 (0); `motion` `{ enabled: boolean, speed: 0.05–2 }` (`{ enabled: false, speed: 0.3 }`).
- Field: ≤ 1280 px on the long side, the scene's aspect. Look lengths (and grain cells) are defined at a 1920-px-wide scene (engine ruling R1).
- The editor server binds **127.0.0.1 only**; random port unless `--port`; opens the browser with `open` (macOS) / `xdg-open` (Linux) unless `--no-open`; always prints the URL.
- ffmpeg is spawned with argv arrays, never a shell (paths with spaces; `tmpDir()` names contain a space).
- Do not modify `src/plan/*` (a parallel branch, fix-c, changes only those files and their tests). Importing from them is fine.
- Lint: `bunx biome check .` reports no errors. Typecheck: `bunx tsc --noEmit`. Tests: `bun test`; CI runs `bun run test` (= `bun test --timeout 120000`); every test slower than 5 s passes an explicit timeout as the last argument of `test(...)`.

## Rulings made while planning (refinements of the spec, each a proposal for the reviewer)

- **B1 — motion speed.** A loop is seamless only with whole-number frequencies, so `motion.speed` cannot literally be "cycles per loop" (0.3 cycles never closes). Every style moves along a closed orbit once per loop (k = 1 or 2) and `speed` sets the orbit's size: 0.05 barely drifts, 2 travels far. The loop length is the master's duration.
- **B2 — animated backdrops, measured.** A full-scene intermediate (Skia upscale + grain per frame + x264) costs **269 ms/frame and 1.3 MB/frame** at a 4K master's scene (4688×2636). Instead the intermediate is the **field** (≤ 1280 px) encoded with `libx264rgb -preset veryfast -crf 12 -pix_fmt rgb24` (**3 ms/frame, 6 KB/frame**, max error 2 levels; `libx264 yuv444p` gave 4). The scene graph reads it with `-stream_loop -1` (verified: output frame i uses loop frame i mod N), upscales it (`scale=…:flags=bicubic`) and adds per-frame grain with ffmpeg's `noise` filter on luma (`c0f=t+u`, `all_seed` = the seed, strength = grain × 220, which matches `applyGrain`'s ±grain×128 levels). Scene-graph time for 90 4K frames: 2.40 s with a looped PNG, 2.34 s with the looped field video + scale + noise.
- **B3 — vignette at field resolution.** The vignette is smooth, so it is applied to the field before the upscale (identical result, 1/9 of the work at 4K). Grain stays at full resolution: Node (`applyGrain`) for stills, ffmpeg `noise` for motion, the page's canvas size in the editor.
- **B4 — grain cells.** Grain uses cells of `round(sceneWidth / 1920)` px, so it reads the same after the camera downsamples a 4K master's scene as it does in the editor.
- **B5 — worker threads for motion.** One 1280×720 field costs 34–144 ms in Bun and **89–256 ms in Node 24** single-threaded (Node's `Math.sin` is ~3× slower). Animated frames are rendered on `min(8, cores − 1)` `node:worker_threads`: Node, 8 workers, M4 Pro: silk 17.5, mesh 25.6, aurora 43.2 ms/frame including the encode. End to end, a 5-s 1080p master renders in 5.9 s with a still shader backdrop and 10.7 s with an animated aurora.
- **B6 — omitted colours.** zod fills every other default; `colors` may be omitted (style palette) and `resolveLook` fills it in, so `plan.json` records the backdrop in full.
- **B7 — presets.** The 13 named in spec §2, plus `horizon` (linear), `halo` (radial) and `prism` (conic) so every style has a preset: 16 shader presets, plus `hero`, `solid`, `none` (19 names). Look presets win on a name clash (`hero`).
- **B8 — editor session lifetime.** The page posts a heartbeat every 5 s; an unsaved session ends 120 s after the last one, 15 min after start if the page never connects, and 5 s after a `pagehide` beacon (`/bye`; a reload heartbeats within the grace). `CAMERAWORK_EDITOR_IDLE_MS` overrides both timeouts (a test knob).
- **B9 — previews without a master.** A neutral 1920×1080 window mock (10 s for the time slider). `look preview --at` defaults to the middle of the master.
- **B10 — server hardening.** Requests must carry `Host: 127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); Save requires `Content-Type: application/json` (no cross-site form posts) and ≤ 1 MB.
- **B11 — styles return linear-light RGB**; `renderField` converts to sRGB bytes through a 16384-entry LUT.
- **B12 — exact tilt in the editor.** Instead of an approximate CSS rotate, the page applies the layout's own homography (`layout.h`) as a CSS `matrix3d`, so the preview's tilt matches the render exactly.
- **B13 — hidden backdrops.** `makeLookAssets` draws no backdrop when the window covers the whole scene (no motion work for `flat`-like looks).

## Measured facts this plan relies on (2026-10-17, Apple M4 Pro, Bun 1.4.3, Node 24.1, ffmpeg 8.1.2)

- esbuild **0.28.2** (latest on npm, published 2026-08-08) bundles `editor/main.ts` with its `../src/**/*.js` imports (resolved to `.ts`), drops `import type` modules (zod never enters), output ≈ 21 KB minified, no `node:` strings.
- `@napi-rs/canvas` 1.0.11: `ctx.putImageData(new ImageData(u8c, w, h), 0, 0)` into a small canvas, `ctx.imageSmoothingQuality = "high"` + `drawImage(small, 0, 0, W, H)`, then `ctx.getImageData(0, 0, W, H)` (returns a `Uint8ClampedArray`; `canvas.data()` returns a **copy**, so write grain into `getImageData().data` and `putImageData` it back). Upscale cost (put + draw + get): 39 ms to 2342×1318, 150 ms to 4688×2636 (`medium`: 13 / 50 ms). A still backdrop for a 4K master's scene: ≈ 1.1–1.2 s, of which PNG encode 0.83 s.
- `new Worker(new URL("./backdrop-worker.ts", import.meta.url))` works in Bun (tests run the `.ts` sources); Node runs the compiled `.js` (verified from `dist/`). Frames transferred with `postMessage(msg, [px.buffer])`.
- A single PNG as the window input (`-i window.png`) through `sceneArgs` with `-frames:v 1` yields exactly one composed frame (used by `look preview` without a master).

## Review Focus

1. **A huge master (8K, a 9368×5272 scene):** the backdrop must not exhaust memory or time. Expected: the field stays ≤ 1280 px; the still path holds at most the scene canvas plus one `getImageData` copy (≈ 2 × 198 MB); the animated path never allocates scene-sized buffers in Node (its intermediate is ≤ 1280 px wide). Tests: Task 6 "a huge master's scene…" and "a huge scene still gets a ≤1280-px intermediate".
2. **A 2-colour palette with styles that expect 3+** (aurora's ribbons, mesh's blobs, ripple's bands) and a 5-colour one: every style still renders a varied, valid picture. Test: `describeStyle` (Task 1's helper), run for every style by Tasks 2–4.
3. **Motion with a very short master** (2 frames, or shorter than one frame): at least one loop frame, the render succeeds, the loop stays seamless. Tests: Task 6 `motionFrameCount` and the 1-frame loop; Task 7 "motion with a 2-frame master renders".
4. **The editor opened without `--master`:** the page gets a placeholder window of known size and a frame to show. Test: Task 8 "without --master…".
5. **A port already in use, or no browser** (a headless Linux box where `xdg-open` fails): a `CameraworkError` naming the port (exit 1); a failed browser open prints the URL with a note and keeps serving. Tests: Task 8 "a port in use…" and "openUrl reports…", Task 10 "a bad or busy --port…".

---

## File structure

| File | Responsibility |
|---|---|
| `src/backdrops/types.ts` | `Vec3`, `STYLE_NAMES`, `StyleName`, `StyleParams`, `ShadeFn`, `StyleDef` |
| `src/backdrops/color.ts` | sRGB ↔ linear ↔ OKLab, `paletteAt`, `mixLab`, `toByte` (LUT) |
| `src/backdrops/noise.ts` | `hash3`, `rand`, `noise2`, `fbm`, `smoothstep`, `tri`, `TAU` (all seeded) |
| `src/backdrops/space.ts` | `along`, `across`: pattern coordinates for an angle and scale |
| `src/backdrops/field.ts` | `FIELD_MAX`, `fieldSize`, `renderField` (style → RGBA bytes) |
| `src/backdrops/post.ts` | `applyVignette`, `applyGrain`, `grainCell` |
| `src/backdrops/gradient.ts` | `gradientLine` (CSS-angle gradient endpoints, shared by render and page) |
| `src/backdrops/styles/classic.ts` | `linear`, `radial`, `conic`, `mesh` → `CLASSIC_STYLES` |
| `src/backdrops/styles/light.ts` | `silk`, `waves`, `aurora` → `LIGHT_STYLES` |
| `src/backdrops/styles/pattern.ts` | `stripes`, `ripple` → `PATTERN_STYLES` |
| `src/backdrops/index.ts` | `STYLES` registry, `shaderColors`, `styleParams`, `shaderField` |
| `src/backdrops/presets.ts` | `BACKDROPS`, `HERO_BACKDROP`, `BackdropPreset` |
| `src/schema.ts` (modify) | the `shader` backdrop variant, `ShaderBackdrop` |
| `src/looks.ts` (modify) | backdrop presets in `resolveLook`, `LOOK_DESCRIPTIONS`, colour completion |
| `src/editor/protocol.ts` | the server ↔ page contract: `EDITOR_ASSETS`, `LookInfo`, `SaveReply`, `HEARTBEAT_MS` |
| `src/render/backdrop.ts` | `shaderCanvas` (still), `renderBackdropVideo`, `motionFilter`, `motionFrameCount`, `intermediateArgs` |
| `src/render/backdrop-frames.ts` | `renderFrames` worker pool, `FrameJob`, `FrameDone`, `backdropThreads` |
| `src/render/backdrop-worker.ts` | the worker thread entry |
| `src/render/assets.ts` (modify) | `backdropCanvas`, `makeLookAssets(…, timing?)`, `LookAssets.motion` |
| `src/render/scene.ts` (modify) | looped video input for animated backdrops |
| `src/render/index.ts`, `src/preview.ts` (modify) | pass the timing to `makeLookAssets` |
| `src/placeholder.ts` | `PLACEHOLDER`, `placeholderWindow` (neutral window mock) |
| `src/editor/server.ts` | `startEditor`, `openUrl` |
| `editor/index.html`, `editor/editor.css` | the page's markup and dark theme |
| `editor/state.ts` | pure page logic: `RANGES`, `shaderFor`, `getPath`/`setPath`, colours, `windowBox` |
| `editor/view.ts` | `paintBackdrop` (canvas drawing, same pipeline as the render) |
| `editor/controls.ts` | `buildControls` (the right-hand form) |
| `editor/main.ts` | page boot: preview, presets grid, Play, time slider, Save/Reset/Copy, heartbeat |
| `scripts/build-editor.mjs` | esbuild bundle → `dist/editor/` |
| `src/look-preview.ts` | `lookPreview` (one composed still) |
| `src/cli.ts`, `src/index.ts` (modify) | `looks`, `look preview`, `look edit`; exports |
| `scripts/presets-sheet.ts`, `docs/images/backdrop-presets.jpg` | README contact sheet |
| `NOTICE` | credits gradflow (MIT) |
| `test/style-helpers.ts` | `testParams`, `mad`, `spread`, `describeStyle` |
| `test/*.test.ts` | one file per task (named in each task) |

## Waves (parallel worktrees)

Tasks in the same wave touch disjoint files and can run in parallel worktrees; merge a wave before starting the next.

| Wave | Tasks | Why this order |
|---|---|---|
| 1 | Task 1 (foundation) | everything imports `types`, `color`, `noise`, `field`, `post` and the test helper |
| 2 | Tasks 2, 3, 4 (style groups) in parallel | each creates only its own `styles/*.ts` and test file |
| 3 | Task 5 (registry, schema, presets, looks, protocol) | imports all three style groups |
| 4 | Tasks 6 (Node backdrop rendering), 8 (editor server), 9 (editor page and build) in parallel | 6: `src/render/backdrop*`; 8: `src/placeholder.ts`, `src/editor/server.ts`; 9: `editor/`, `scripts/build-editor.mjs`, `package.json`, `bun.lock`, `tsconfig.json`, `biome.json`, CI |
| 5 | Task 7 (scene graph integration) | needs Task 6 |
| 6 | Task 10 (commands) | needs Tasks 7, 8, 9 |
| 7 | Task 11 (README backdrop and editor docs, NOTICE, contact sheet) | needs everything; last |

---
### Task 1: Backdrop foundation (colour, noise, field, post)

**Files:**
- Create: `src/backdrops/types.ts`, `src/backdrops/color.ts`, `src/backdrops/noise.ts`, `src/backdrops/space.ts`, `src/backdrops/field.ts`, `src/backdrops/post.ts`, `src/backdrops/gradient.ts`
- Create: `test/style-helpers.ts` (shared by Tasks 2–6)
- Test: `test/backdrops-core.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (exact):
  - `types.ts`: `type Vec3 = [number, number, number]`; `const STYLE_NAMES = ["silk", "waves", "aurora", "mesh", "stripes", "ripple", "linear", "radial", "conic"] as const`; `type StyleName`; `interface StyleParams { lab: Vec3[]; sin: number; cos: number; scale: number; distortion: number; seed: number; speed: number; uMax: number; vMax: number }`; `type ShadeFn = (u: number, v: number, t: number, p: StyleParams) => Vec3` (linear-light RGB); `interface StyleDef { description: string; colors: string[]; shade: ShadeFn }`.
  - `color.ts`: `hexToLinear(hex: string): Vec3`, `linearToOklab(c: Vec3): Vec3`, `oklabToLinear(L: number, a: number, b: number): Vec3`, `mixLab(a: Vec3, b: Vec3, k: number, light = 1): Vec3`, `paletteAt(lab: Vec3[], x: number, light = 1, glow = 0): Vec3`, `toByte(x: number): number`.
  - `noise.ts`: `TAU`, `hash3(seed, x, y): number` in [0, 1), `rand(seed, n): number`, `noise2(seed, x, y): number`, `fbm(seed, x, y, octaves = 3): number`, `smoothstep(a, b, x): number`, `tri(x): number`.
  - `space.ts`: `along(u, v, p: StyleParams): number`, `across(u, v, p: StyleParams): number`.
  - `field.ts`: `FIELD_MAX = 1280`, `fieldSize(w, h, max = FIELD_MAX): [number, number]`, `renderField(shade: ShadeFn, p: StyleParams, w, h, t, out?: Uint8ClampedArray): Uint8ClampedArray`.
  - `post.ts`: `applyVignette(px: Uint8Array | Uint8ClampedArray, w, h, strength): void`, `interface GrainSettings { grain: number; seed: number; frame: number; cell: number }`, `applyGrain(px, w, h, s: GrainSettings): void`, `grainCell(sceneWidth: number): number`.
  - `gradient.ts`: `gradientLine(w, h, angle): [x0, y0, x1, y1]`.
  - `test/style-helpers.ts`: `testParams(colors: string[], w = 160, h = 90, over: Partial<StyleParams> = {}): StyleParams`, `mad(a, b: Uint8ClampedArray): number`, `spread(px: Uint8ClampedArray): number`, `describeStyle(name: string, style: StyleDef): void` (registers the standard style tests).

None of these files may import a `node:` module (they are bundled into the editor page).

- [ ] **Step 1: Write the shared style test helper**

`test/style-helpers.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { hexToLinear, linearToOklab } from "../src/backdrops/color.js";
import { renderField } from "../src/backdrops/field.js";
import type { StyleDef, StyleParams } from "../src/backdrops/types.js";

/** StyleParams for a w×h field from hex colours and the spec's defaults (angle 45, scale 1, distortion 0.3, seed 1). */
export function testParams(colors: string[], w = 160, h = 90, over: Partial<StyleParams> = {}): StyleParams {
  const short = Math.min(w, h);
  const rad = (45 * Math.PI) / 180;
  return {
    lab: colors.map((c) => linearToOklab(hexToLinear(c))),
    sin: Math.sin(rad),
    cos: Math.cos(rad),
    scale: 1,
    distortion: 0.3,
    seed: 1,
    speed: 0,
    uMax: w / short,
    vMax: h / short,
    ...over,
  };
}

/** Mean absolute difference per colour channel between two RGBA buffers. */
export function mad(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) sum += Math.abs((a[i] as number) - (b[i] as number));
  return sum / ((a.length * 3) / 4);
}

/** Standard deviation of the red, green and blue bytes together. */
export function spread(px: Uint8ClampedArray): number {
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let i = 0; i < px.length; i++) {
    if (i % 4 === 3) continue;
    const v = px[i] as number;
    sum += v;
    sq += v * v;
    n++;
  }
  return Math.sqrt(sq / n - (sum / n) ** 2);
}

/** The checks every style must pass (spec §8 "Styles" and "Motion"). */
export function describeStyle(name: string, style: StyleDef): void {
  const W = 160;
  const H = 90;
  const field = (p: StyleParams, t: number) => renderField(style.shade, p, W, H, t);

  describe(`style ${name}`, () => {
    test("has a description and a 2–5 colour default palette", () => {
      expect(style.description.length).toBeGreaterThan(10);
      expect(style.colors.length).toBeGreaterThanOrEqual(2);
      expect(style.colors.length).toBeLessThanOrEqual(5);
      for (const c of style.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    });

    test("is deterministic: the same settings give the same bytes", () => {
      const p = testParams(style.colors, W, H, { speed: 0.5 });
      expect(Buffer.from(field(p, 0.3)).equals(Buffer.from(field(p, 0.3)))).toBe(true);
    });

    test("returns finite colours near 0–1 everywhere", () => {
      const p = testParams(style.colors, W, H, { speed: 1, distortion: 1 });
      for (let i = 0; i < 400; i++) {
        const c = style.shade((i % 20) / 10, Math.floor(i / 20) / 20, (i % 7) / 7, p);
        for (const x of c) {
          expect(Number.isFinite(x)).toBe(true);
          expect(x).toBeGreaterThan(-0.15);
          expect(x).toBeLessThan(1.3);
        }
      }
    });

    test("is not a flat image", () => {
      expect(spread(field(testParams(style.colors, W, H), 0))).toBeGreaterThan(8);
    });

    test("works with 2 and with 5 colours (Review Focus 2)", () => {
      for (const colors of [
        ["#000000", "#ffffff"],
        ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff"],
      ])
        expect(spread(field(testParams(colors, W, H), 0))).toBeGreaterThan(8);
    });

    test("seed changes the picture or leaves it valid", () => {
      const a = field(testParams(style.colors, W, H, { seed: 1, distortion: 0.8 }), 0);
      const b = field(testParams(style.colors, W, H, { seed: 99, distortion: 0.8 }), 0);
      expect(mad(a, b)).toBeGreaterThan(0.5);
    });

    test("without motion, every t gives the same picture", () => {
      const p = testParams(style.colors, W, H);
      expect(mad(field(p, 0), field(p, 0.37))).toBe(0);
    });

    test("with motion it moves and loops seamlessly: t = 1 is t = 0, and the wrap is an ordinary step", () => {
      const p = testParams(style.colors, W, H, { speed: 1 });
      const n = 24;
      const frames = Array.from({ length: n }, (_, k) => field(p, k / n));
      const first = frames[0] as Uint8ClampedArray;
      expect(mad(first, field(p, 1))).toBeLessThan(0.01);
      const steps = frames.map((f, k) => mad(f, frames[(k + 1) % n] as Uint8ClampedArray));
      const wrap = steps[n - 1] as number;
      expect(wrap).toBeLessThanOrEqual(Math.max(...steps.slice(0, n - 1)) * 1.1 + 0.05);
      expect(Math.max(...frames.map((f) => mad(first, f)))).toBeGreaterThan(1);
    });
  });
}
```

- [ ] **Step 2: Write the failing foundation tests**

`test/backdrops-core.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { hexToLinear, linearToOklab, mixLab, oklabToLinear, paletteAt, toByte } from "../src/backdrops/color.js";
import { FIELD_MAX, fieldSize, renderField } from "../src/backdrops/field.js";
import { gradientLine } from "../src/backdrops/gradient.js";
import { fbm, hash3, noise2, rand, smoothstep, tri } from "../src/backdrops/noise.js";
import { applyGrain, applyVignette, grainCell } from "../src/backdrops/post.js";
import { across, along } from "../src/backdrops/space.js";
import type { ShadeFn, Vec3 } from "../src/backdrops/types.js";
import { testParams } from "./style-helpers.js";

const flat = (w: number, h: number, v: number) =>
  new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : v));

describe("colour", () => {
  test("OKLab round-trips and has white at L = 1", () => {
    for (const hex of ["#000000", "#ffffff", "#ff2bd6", "#1a0b3d", "#7b2bff"]) {
      const lin = hexToLinear(hex);
      const back = oklabToLinear(...linearToOklab(lin));
      for (let i = 0; i < 3; i++) expect(back[i] as number).toBeCloseTo(lin[i] as number, 5);
    }
    expect(linearToOklab([1, 1, 1])[0]).toBeCloseTo(1, 4);
  });

  test("palettes mix in OKLab: halfway between black and white is sRGB 99, not 128", () => {
    const lab = [linearToOklab(hexToLinear("#000000")), linearToOklab(hexToLinear("#ffffff"))];
    const mid = paletteAt(lab, 0.5);
    expect(toByte(mid[0])).toBe(99);
    expect(toByte(mixLab(lab[0] as Vec3, lab[1] as Vec3, 0.5)[1])).toBe(99);
  });

  test("palette ends are the first and last colours; x is clamped", () => {
    const lab = ["#ff0000", "#00ff00", "#0000ff"].map((c) => linearToOklab(hexToLinear(c)));
    expect(paletteAt(lab, -1).map(toByte)).toEqual([255, 0, 0]);
    expect(paletteAt(lab, 2).map(toByte)).toEqual([0, 0, 255]);
  });

  test("toByte clamps and treats NaN as 0", () => {
    expect([toByte(-1), toByte(0), toByte(1), toByte(2), toByte(Number.NaN)]).toEqual([0, 0, 255, 255, 0]);
  });
});

describe("noise", () => {
  test("hash3 is deterministic, in [0, 1), and depends on every input", () => {
    expect(hash3(1, 2, 3)).toBe(hash3(1, 2, 3));
    for (const h of [hash3(1, 2, 3), hash3(2, 2, 3), hash3(1, 3, 3), hash3(1, 2, 4)]) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
    expect(new Set([hash3(1, 2, 3), hash3(2, 2, 3), hash3(1, 3, 3), hash3(1, 2, 4)]).size).toBe(4);
    expect(rand(7, 0)).not.toBe(rand(7, 1));
  });

  test("value noise and fbm are smooth and stay in [0, 1]", () => {
    for (let i = 0; i < 500; i++) {
      const x = i * 0.137 - 30;
      const y = i * 0.071 + 5;
      const n = noise2(3, x, y);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
      expect(Math.abs(noise2(3, x + 0.001, y) - n)).toBeLessThan(0.01);
      const f = fbm(3, x, y, 3);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  test("smoothstep and tri", () => {
    expect([smoothstep(0, 1, -1), smoothstep(0, 1, 0.5), smoothstep(0, 1, 2)]).toEqual([0, 0.5, 1]);
    expect([tri(0), tri(0.25), tri(0.5), tri(1), tri(-0.5)]).toEqual([0, 0.5, 1, 0, 1]);
  });
});

describe("pattern space", () => {
  test("angle 90 runs left to right; angle 0 runs upwards", () => {
    const right = testParams(["#000000", "#ffffff"], 200, 100, { sin: 1, cos: 0 });
    expect(along(2, 0.5, right)).toBeCloseTo(1, 9);
    expect(along(0, 0.5, right)).toBeCloseTo(-1, 9);
    const up = testParams(["#000000", "#ffffff"], 200, 100, { sin: 0, cos: 1 });
    expect(along(1, 0, up)).toBeCloseTo(0.5, 9);
    expect(across(2, 0.5, up)).toBeCloseTo(1, 9);
  });
});

describe("field", () => {
  test("fieldSize keeps the aspect, caps the long side at 1280 and is even", () => {
    expect(FIELD_MAX).toBe(1280);
    expect(fieldSize(4688, 2636)).toEqual([1280, 720]);
    expect(fieldSize(640, 360)).toEqual([640, 360]);
    expect(fieldSize(9368, 5272)).toEqual([1280, 720]);
    expect(fieldSize(2636, 4688)).toEqual([720, 1280]);
    expect(fieldSize(1, 1)).toEqual([2, 2]);
  });

  test("renders opaque pixels with the short side spanning 0–1", () => {
    let maxU = 0;
    let maxV = 0;
    const shade: ShadeFn = (u, v) => {
      maxU = Math.max(maxU, u);
      maxV = Math.max(maxV, v);
      return [1, 0, 0];
    };
    const px = renderField(shade, testParams(["#000000", "#ffffff"], 200, 100), 200, 100, 0);
    expect(maxU).toBeCloseTo(2 - 0.005, 6);
    expect(maxV).toBeCloseTo(1 - 0.005, 6);
    expect([...px.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(px[px.length - 1]).toBe(255);
  });

  test("the same settings look the same at any resolution", () => {
    const shade: ShadeFn = (u, v, _t, p) => paletteAt(p.lab, (u / p.uMax + v) / 2);
    const small = renderField(shade, testParams(["#102030", "#f0e0d0"], 160, 90), 160, 90, 0);
    const big = renderField(shade, testParams(["#102030", "#f0e0d0"], 320, 180), 320, 180, 0);
    // pixel (40, 20) in the small field covers pixels (80–81, 40–41) in the big one
    const s = (40 + 20 * 160) * 4;
    const b = (81 + 41 * 320) * 4;
    expect(Math.abs((small[s] as number) - (big[b] as number))).toBeLessThanOrEqual(2);
  });
});

describe("post", () => {
  test("vignette leaves the centre and darkens the corners", () => {
    const px = flat(100, 50, 200);
    applyVignette(px, 100, 50, 1);
    expect(px[(25 * 100 + 50) * 4]).toBe(200);
    expect(px[0] as number).toBeLessThan(60);
    const none = flat(10, 10, 200);
    applyVignette(none, 10, 10, 0);
    expect(none.every((v, i) => v === (i % 4 === 3 ? 255 : 200))).toBe(true);
  });

  test("grain is monochrome, seeded per frame, bounded and roughly zero-mean", () => {
    const run = (frame: number) => {
      const px = flat(64, 64, 128);
      applyGrain(px, 64, 64, { grain: 0.1, seed: 5, frame, cell: 1 });
      return px;
    };
    const a = run(0);
    expect(Buffer.from(a).equals(Buffer.from(run(0)))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(run(1)))).toBe(false);
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) {
      expect(a[i]).toBe(a[i + 1] as number);
      expect(a[i]).toBe(a[i + 2] as number);
      expect(Math.abs((a[i] as number) - 128)).toBeLessThanOrEqual(13);
      sum += (a[i] as number) - 128;
    }
    expect(Math.abs(sum / (64 * 64))).toBeLessThan(1);
  });

  test("grain cells: cell 2 makes 2×2 blocks; grainCell sizes cells for a 1920-px scene", () => {
    const px = flat(8, 8, 128);
    applyGrain(px, 8, 8, { grain: 0.3, seed: 1, frame: 0, cell: 2 });
    expect(px[0]).toBe(px[4] as number);
    expect(px[0]).toBe(px[8 * 4] as number);
    expect([grainCell(1000), grainCell(1920), grainCell(3840), grainCell(4688)]).toEqual([1, 1, 2, 2]);
  });
});

describe("gradient line", () => {
  test("CSS angles: 180 is top to bottom, 90 is left to right", () => {
    expect(gradientLine(100, 100, 180).map((n) => Math.round(n))).toEqual([50, 0, 50, 100]);
    expect(gradientLine(200, 100, 90).map((n) => Math.round(n))).toEqual([0, 50, 200, 50]);
  });
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `bun test test/backdrops-core.test.ts`
Expected: FAIL with `Cannot find module '../src/backdrops/color.js'`.

- [ ] **Step 4: Write the types**

`src/backdrops/types.ts`:

```ts
/** Three floats: linear-light RGB (each 0–1) or OKLab (L, a, b), as named where used. */
export type Vec3 = [number, number, number];

export const STYLE_NAMES = [
  "silk",
  "waves",
  "aurora",
  "mesh",
  "stripes",
  "ripple",
  "linear",
  "radial",
  "conic",
] as const;
export type StyleName = (typeof STYLE_NAMES)[number];

/** A shader backdrop's settings, resolved for one field size, in the form the styles use. */
export interface StyleParams {
  /** The palette in OKLab, 2–5 colours. */
  lab: Vec3[];
  /** sin and cos of the angle. The pattern runs along (sin, -cos): 0° points up and 90° right, as in CSS. */
  sin: number;
  cos: number;
  /** Pattern size: 2 makes every feature twice as large. */
  scale: number;
  distortion: number;
  /** An unsigned 32-bit seed. */
  seed: number;
  /** The motion orbit's size: motion.speed when motion is enabled, else 0 (then every t gives the same picture). */
  speed: number;
  /** The field's extent: u runs 0–uMax and v 0–vMax; the shorter one is 1. */
  uMax: number;
  vMax: number;
}

/**
 * A background style: linear-light RGB (0–1; the caller clamps) at aspect-corrected (u, v) and loop time t in [0, 1).
 * Pure and periodic in t: every time term is sin/cos of 2πt·k for a whole number k, so t = 1 equals t = 0.
 */
export type ShadeFn = (u: number, v: number, t: number, p: StyleParams) => Vec3;

export interface StyleDef {
  /** One line for `camerawork looks` and the editor. */
  description: string;
  /** The palette used when a backdrop gives no colours. */
  colors: string[];
  shade: ShadeFn;
}
```

- [ ] **Step 5: Write colour (OKLab mixing, sRGB LUT)**

`src/backdrops/color.ts`:

```ts
import type { Vec3 } from "./types.js";

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** `#rrggbb` → linear-light RGB. */
export function hexToLinear(hex: string): Vec3 {
  const n = Number.parseInt(hex.slice(1), 16);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
}

export function linearToOklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToLinear(L: number, a: number, b: number): Vec3 {
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

/** Mixes two OKLab colours (k = 0 → a, 1 → b), multiplies the lightness by `light`, and returns linear RGB. */
export function mixLab(a: Vec3, b: Vec3, k: number, light = 1): Vec3 {
  return oklabToLinear((a[0] + (b[0] - a[0]) * k) * light, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
}

/**
 * The palette colour at x (0–1, clamped; the colours sit at equal steps), mixed in OKLab, with its lightness
 * multiplied by `light` and then raised by `glow` (a sheen), as linear RGB.
 */
export function paletteAt(lab: Vec3[], x: number, light = 1, glow = 0): Vec3 {
  const n = lab.length - 1;
  const f = (x <= 0 ? 0 : x >= 1 ? 1 : x) * n;
  const i = f >= n ? n - 1 : Math.floor(f);
  const k = f - i;
  const a = lab[i] as Vec3;
  const b = lab[i + 1] as Vec3;
  return oklabToLinear((a[0] + (b[0] - a[0]) * k) * light + glow, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
}

const LUT_SIZE = 16384;
const LUT = new Uint8Array(LUT_SIZE + 1);
for (let i = 0; i <= LUT_SIZE; i++) LUT[i] = Math.round(255 * toSrgb(i / LUT_SIZE));

/** Linear-light 0–1 (clamped; NaN counts as 0) → an sRGB byte. */
export function toByte(x: number): number {
  return LUT[x >= 1 ? LUT_SIZE : x > 0 ? Math.round(x * LUT_SIZE) : 0] as number;
}
```

- [ ] **Step 6: Write seeded noise**

`src/backdrops/noise.ts` (value noise on a cached 256×256 seeded lattice: measured no slower than hashing every corner, and it keeps `fbm` cheap):

```ts
export const TAU = Math.PI * 2;

/** A well-mixed 32-bit hash of integer (seed, x, y) as a float in [0, 1). Same inputs, same output. */
export function hash3(seed: number, x: number, y: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(x | 0, 0xc2b2ae35) ^ Math.imul(y | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** The n-th random number in [0, 1) for a seed (blob positions and the like). */
export const rand = (seed: number, n: number): number => hash3(seed, n, 0x5bd1e995);

const tables = new Map<number, Float32Array>();

/** 256×256 random lattice values for a seed, built once and cached (the last 16 seeds). */
function lattice(seed: number): Float32Array {
  let table = tables.get(seed);
  if (table) return table;
  table = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) table[i] = hash3(seed, i & 255, i >> 8);
  if (tables.size >= 16) tables.delete(tables.keys().next().value as number);
  tables.set(seed, table);
  return table;
}

/** Smooth value noise in [0, 1]; it repeats every 256 units. */
export function noise2(seed: number, x: number, y: number): number {
  const table = lattice(seed);
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = xi & 255;
  const x1 = (x0 + 1) & 255;
  const y0 = (yi & 255) << 8;
  const y1 = (y0 + 256) & 0xff00;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const a = table[y0 | x0] as number;
  const b = table[y0 | x1] as number;
  const c = table[y1 | x0] as number;
  const d = table[y1 | x1] as number;
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal noise: `octaves` layers of value noise, each twice as fine and half as strong, in [0, 1]. */
export function fbm(seed: number, x: number, y: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(seed, x, y);
    norm += amp;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 3.7;
    amp *= 0.5;
  }
  return sum / norm;
}

export function smoothstep(a: number, b: number, x: number): number {
  const k = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return k * k * (3 - 2 * k);
}

/** A triangle wave with period 1: 0 at whole numbers, 1 halfway. */
export const tri = (x: number): number => 1 - Math.abs(2 * (x - Math.floor(x)) - 1);
```

- [ ] **Step 7: Write pattern space, field, post-effects and the gradient line**

`src/backdrops/space.ts`:

```ts
import type { StyleParams } from "./types.js";

/** Distance along the pattern's direction from the field's centre, in pattern units (divided by scale). */
export const along = (u: number, v: number, p: StyleParams): number =>
  ((u - p.uMax / 2) * p.sin - (v - p.vMax / 2) * p.cos) / p.scale;

/** Distance across the pattern's direction from the field's centre, in pattern units (divided by scale). */
export const across = (u: number, v: number, p: StyleParams): number =>
  ((u - p.uMax / 2) * p.cos + (v - p.vMax / 2) * p.sin) / p.scale;
```

`src/backdrops/field.ts`:

```ts
import { toByte } from "./color.js";
import type { ShadeFn, StyleParams } from "./types.js";

/** The long side of the reduced-size field a shader backdrop is computed at (spec §4). */
export const FIELD_MAX = 1280;

/** The field size for a w×h target: the same aspect, the long side at most `max`, both sides even and ≥ 2. */
export function fieldSize(w: number, h: number, max = FIELD_MAX): [number, number] {
  const k = Math.min(1, max / Math.max(w, h));
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return [even(w), even(h)];
}

/**
 * Renders a style as opaque RGBA bytes, w×h, at loop time t. Pixel centres map to (u, v) with the short side
 * spanning 0–1, so the same settings give the same picture at any resolution. `out` is reused when given.
 */
export function renderField(
  shade: ShadeFn,
  p: StyleParams,
  w: number,
  h: number,
  t: number,
  out: Uint8ClampedArray = new Uint8ClampedArray(w * h * 4),
): Uint8ClampedArray {
  const k = 1 / Math.min(w, h);
  let i = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * k;
    for (let x = 0; x < w; x++) {
      const c = shade((x + 0.5) * k, v, t, p);
      out[i] = toByte(c[0]);
      out[i + 1] = toByte(c[1]);
      out[i + 2] = toByte(c[2]);
      out[i + 3] = 255;
      i += 4;
    }
  }
  return out;
}
```

`src/backdrops/post.ts`:

```ts
import { hash3, smoothstep } from "./noise.js";

type Pixels = Uint8Array | Uint8ClampedArray;

const clampByte = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);

/** Darkens the edges of opaque RGBA pixels (w×h) in place; strength 0–1 (1 leaves the corners at 15 %). */
export function applyVignette(px: Pixels, w: number, h: number, strength: number): void {
  if (strength <= 0) return;
  const cx = w / 2;
  const cy = h / 2;
  const inv = 1 / Math.hypot(cx, cy);
  let i = 0;
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5 - cy) * inv;
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) * inv;
      const f = 1 - 0.85 * strength * smoothstep(0.3, 1, Math.sqrt(dx * dx + dy * dy));
      px[i] = clampByte((px[i] as number) * f);
      px[i + 1] = clampByte((px[i + 1] as number) * f);
      px[i + 2] = clampByte((px[i + 2] as number) * f);
      i += 4;
    }
  }
}

export interface GrainSettings {
  /** 0–0.3: each pixel moves by up to ±grain × 128 levels, the same on all three channels. */
  grain: number;
  seed: number;
  /** Frame number: 0 for stills; animated backdrops re-seed the grain every frame. */
  frame: number;
  /** Grain cell size in pixels (see grainCell). */
  cell: number;
}

/** Adds seeded monochrome grain to opaque RGBA pixels (w×h) in place. */
export function applyGrain(px: Pixels, w: number, h: number, s: GrainSettings): void {
  if (s.grain <= 0) return;
  const amp = s.grain * 256;
  const seed = (s.seed ^ Math.imul(s.frame + 1, 0x9e3779b1)) >>> 0;
  const cell = Math.max(1, Math.floor(s.cell));
  let i = 0;
  for (let y = 0; y < h; y++) {
    const gy = Math.floor(y / cell);
    for (let x = 0; x < w; x++) {
      const n = (hash3(seed, Math.floor(x / cell), gy) - 0.5) * amp;
      px[i] = clampByte((px[i] as number) + n);
      px[i + 1] = clampByte((px[i + 1] as number) + n);
      px[i + 2] = clampByte((px[i + 2] as number) + n);
      i += 4;
    }
  }
}

/** Grain is sized for a 1920-px-wide scene (like look lengths, ruling R1): one cell per 1920th of the width. */
export const grainCell = (sceneWidth: number): number => Math.max(1, Math.round(sceneWidth / 1920));
```

`src/backdrops/gradient.ts` (the same math as today's gradient in `src/render/assets.ts`, which Task 7 switches to it):

```ts
/** The start and end points [x0, y0, x1, y1] of a CSS-style linear gradient (180° = top → bottom) over w×h. */
export function gradientLine(w: number, h: number, angle: number): [number, number, number, number] {
  const a = ((angle - 90) * Math.PI) / 180;
  const half = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2;
  return [
    w / 2 - Math.cos(a) * half,
    h / 2 - Math.sin(a) * half,
    w / 2 + Math.cos(a) * half,
    h / 2 + Math.sin(a) * half,
  ];
}
```

- [ ] **Step 8: Run the tests, lint and typecheck**

Run: `bun test test/backdrops-core.test.ts && bunx biome check src test && bunx tsc --noEmit`
Expected: PASS (15 tests), no lint errors, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/backdrops test/style-helpers.ts test/backdrops-core.test.ts
git commit -m "feat(backdrops): OKLab colour, seeded noise, field rendering, grain and vignette"
```

---

### Task 2: Classic styles (linear, radial, conic, mesh)

**Files:**
- Create: `src/backdrops/styles/classic.ts`
- Test: `test/styles-classic.test.ts`

**Interfaces:**
- Consumes (Task 1): `StyleDef`, `StyleParams`, `Vec3` from `../types.js`; `oklabToLinear`, `paletteAt` from `../color.js`; `fbm`, `rand`, `TAU` from `../noise.js`; `along`, `across` from `../space.js`; `describeStyle` from `test/style-helpers.ts`.
- Produces: `export const CLASSIC_STYLES: { linear: StyleDef; radial: StyleDef; conic: StyleDef; mesh: StyleDef }`.

- [ ] **Step 1: Write the failing test**

`test/styles-classic.test.ts`:

```ts
import { CLASSIC_STYLES } from "../src/backdrops/styles/classic.js";
import { describeStyle } from "./style-helpers.js";

for (const [name, style] of Object.entries(CLASSIC_STYLES)) describeStyle(name, style);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/styles-classic.test.ts`
Expected: FAIL with `Cannot find module '../src/backdrops/styles/classic.js'`.

- [ ] **Step 3: Write the styles**

`src/backdrops/styles/classic.ts` (`mesh` caches its blob centres per `(settings, t)`, so it computes them once per frame rather than once per pixel; its output still depends only on its inputs):

```ts
import { oklabToLinear, paletteAt } from "../color.js";
import { fbm, rand, TAU } from "../noise.js";
import { across, along } from "../space.js";
import type { StyleDef, StyleParams, Vec3 } from "../types.js";

/** A noise offset of about ±0.5 × distortion that drifts around a closed loop as t goes 0 → 1. */
function wobble(u: number, v: number, t: number, p: StyleParams): number {
  if (p.distortion === 0) return 0;
  const a = TAU * t;
  const x = (u * 1.5) / p.scale + p.speed * Math.cos(a);
  const y = (v * 1.5) / p.scale + p.speed * Math.sin(a);
  return (fbm(p.seed, x, y, 3) - 0.5) * p.distortion;
}

const linear: StyleDef = {
  description: "a straight gradient along the angle",
  colors: ["#0f172a", "#3b82f6", "#a5f3fc"],
  shade(u, v, t, p) {
    const reach = Math.abs(p.uMax * p.sin) + Math.abs(p.vMax * p.cos);
    return paletteAt(p.lab, 0.5 + along(u, v, p) / reach + 0.4 * wobble(u, v, t, p));
  },
};

const radial: StyleDef = {
  description: "a round glow from the centre outwards",
  colors: ["#fde68a", "#f97316", "#1c0a00"],
  shade(u, v, t, p) {
    const du = u - p.uMax / 2;
    const dv = v - p.vMax / 2;
    const r = Math.sqrt(du * du + dv * dv) / (0.5 * Math.hypot(p.uMax, p.vMax) * p.scale);
    return paletteAt(p.lab, r + 0.4 * wobble(u, v, t, p));
  },
};

const conic: StyleDef = {
  description: "colours sweeping around the centre",
  colors: ["#6d28d9", "#ec4899", "#f59e0b", "#06b6d4"],
  shade(u, v, t, p) {
    const turn = 0.15 * p.speed * Math.sin(TAU * t);
    const a = Math.atan2(across(u, v, p), -along(u, v, p)) / TAU + 0.5 + turn + 0.3 * wobble(u, v, t, p);
    const f = a - Math.floor(a);
    return paletteAt(p.lab, 1 - Math.abs(2 * f - 1)); // mirrored, so the sweep has no seam
  },
};

// mesh recomputes its blob centres once per (settings, t), not once per pixel; the output depends only on the inputs.
let blobsFor: StyleParams | null = null;
let blobsAt = Number.NaN;
let blobs: number[] = [];

function meshBlobs(t: number, p: StyleParams): number[] {
  if (blobsFor === p && blobsAt === t) return blobs;
  const a = TAU * t;
  const n = Math.max(3, p.lab.length + 1);
  blobs = [];
  for (let i = 0; i < n; i++) {
    const phase = rand(p.seed, i * 3 + 2) * TAU;
    blobs.push(
      (0.1 + 0.8 * rand(p.seed, i * 3)) * p.uMax + 0.12 * p.speed * Math.cos(a + phase),
      (0.1 + 0.8 * rand(p.seed, i * 3 + 1)) * p.vMax + 0.12 * p.speed * Math.sin(a + phase),
    );
  }
  blobsFor = p;
  blobsAt = t;
  return blobs;
}

const mesh: StyleDef = {
  description: "soft colour blobs blended together (placed by the seed)",
  colors: ["#ff9a9e", "#fecfef", "#a18cd1", "#f6d365"],
  shade(u, v, t, p) {
    const centres = meshBlobs(t, p);
    const wu = u + 0.5 * wobble(u, v, t, p);
    const wv = v + 0.5 * wobble(v + 3.1, u + 7.3, t, p);
    const spread = 2 * (0.32 * p.scale) ** 2;
    let L = 0;
    let A = 0;
    let B = 0;
    let total = 0;
    for (let i = 0; i < centres.length / 2; i++) {
      const du = wu - (centres[2 * i] as number);
      const dv = wv - (centres[2 * i + 1] as number);
      const w = Math.exp(-(du * du + dv * dv) / spread) + 1e-6;
      const c = p.lab[i % p.lab.length] as Vec3;
      L += w * c[0];
      A += w * c[1];
      B += w * c[2];
      total += w;
    }
    return oklabToLinear(L / total, A / total, B / total);
  },
};

export const CLASSIC_STYLES = { linear, radial, conic, mesh };
```

- [ ] **Step 4: Run the test, lint and typecheck**

Run: `bun test test/styles-classic.test.ts && bunx biome check src test && bunx tsc --noEmit`
Expected: PASS (4 styles × 8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backdrops/styles/classic.ts test/styles-classic.test.ts
git commit -m "feat(backdrops): linear, radial, conic and mesh styles"
```

---

### Task 3: Light styles (silk, waves, aurora)

**Files:**
- Create: `src/backdrops/styles/light.ts`
- Test: `test/styles-light.test.ts`

**Interfaces:**
- Consumes (Task 1): `StyleDef`, `Vec3`; `oklabToLinear`, `paletteAt`; `fbm`, `noise2`, `smoothstep`, `TAU`; `along`, `across`; `describeStyle`.
- Produces: `export const LIGHT_STYLES: { silk: StyleDef; waves: StyleDef; aurora: StyleDef }`.

- [ ] **Step 1: Write the failing test**

`test/styles-light.test.ts`:

```ts
import { LIGHT_STYLES } from "../src/backdrops/styles/light.js";
import { describeStyle } from "./style-helpers.js";

for (const [name, style] of Object.entries(LIGHT_STYLES)) describeStyle(name, style);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/styles-light.test.ts`
Expected: FAIL with `Cannot find module '../src/backdrops/styles/light.js'`.

- [ ] **Step 3: Write the styles**

`src/backdrops/styles/light.ts` (`silk`'s sheen is `band¹²` by repeated multiplication: `**` measured slow in V8):

```ts
import { oklabToLinear, paletteAt } from "../color.js";
import { fbm, noise2, smoothstep, TAU } from "../noise.js";
import { across, along } from "../space.js";
import type { StyleDef, Vec3 } from "../types.js";

const silk: StyleDef = {
  description: "soft diagonal bands of light with a sheen, like folded fabric",
  colors: ["#12002e", "#7b2bff", "#ff2bd6"],
  shade(u, v, t, p) {
    const a = TAU * t;
    const s = along(u, v, p);
    const q = across(u, v, p);
    const warp = fbm(p.seed, q * 0.8 + 0.5 * p.speed * Math.cos(a), s * 0.8 + 0.5 * p.speed * Math.sin(a), 3) - 0.5;
    const fold = s + 1.2 * p.distortion * warp + 0.25 * Math.sin(q * 1.7 + 0.8 * p.speed * Math.sin(a + 1));
    const band = 0.5 + 0.5 * Math.sin(fold * 6.5);
    const b4 = band * band * band * band;
    const sheen = b4 * b4 * b4;
    return paletteAt(p.lab, 0.5 + 0.5 * Math.sin(fold * 2.3 + 0.4), 0.6 + 0.4 * band, 0.14 * sheen);
  },
};

const waves: StyleDef = {
  description: "layered flowing waves, stacked along the angle",
  colors: ["#0b1d3a", "#1e6091", "#52b69a", "#d9ed92"],
  shade(u, v, t, p) {
    const a = TAU * t;
    const s = along(u, v, p);
    const q = across(u, v, p);
    const layers = 5;
    let x = 0;
    let light = 1;
    for (let k = 0; k < layers; k++) {
      const phase = k * 1.7 + (p.seed % 97) * 0.13;
      const edge =
        (k - (layers - 1) / 2) * 0.22 +
        0.08 * Math.sin(q * (1.8 + 0.6 * k) + phase + 0.9 * p.speed * Math.sin(a + k)) +
        0.3 * p.distortion * (noise2(p.seed + k, q * 1.3 + 0.4 * p.speed * Math.cos(a), k * 7.1) - 0.5);
      const d = s - edge;
      x += smoothstep(-0.012, 0.012, d) / layers;
      const e = d + 0.03;
      light *= 1 - 0.18 * Math.exp(-(e * e) / 0.0012) * (d < 0 ? 1 : 0.4); // a soft shadow under each crest
    }
    return paletteAt(p.lab, x, light);
  },
};

const aurora: StyleDef = {
  description: "wide glowing ribbons over a dark base (the first colour)",
  colors: ["#020617", "#22d3ee", "#a855f7", "#4ade80"],
  shade(u, v, t, p) {
    const a = TAU * t;
    const s = along(u, v, p);
    const q = across(u, v, p);
    const base = p.lab[0] as Vec3;
    let L = base[0];
    let A = base[1];
    let B = base[2];
    const ribbons = Math.max(1, p.lab.length - 1);
    for (let k = 0; k < ribbons; k++) {
      const c = p.lab[Math.min(k + 1, p.lab.length - 1)] as Vec3;
      const centre =
        (k - (ribbons - 1) / 2) * 0.3 +
        0.18 * Math.sin(q * (1.1 + 0.35 * k) + k * 2.1 + 0.7 * p.speed * Math.sin(a + k * 1.3)) +
        0.4 * p.distortion * (fbm(p.seed + k, q * 0.9 + 0.3 * p.speed * Math.cos(a), k * 5.3, 2) - 0.5);
      const d = (s - centre) / 0.22;
      const streak = 0.7 + 0.3 * fbm(p.seed + 31 * k, q * 12 + 0.3 * p.speed * Math.cos(a), s * 0.2, 2);
      const glow = Math.exp(-d * d) * streak;
      L += (c[0] - L) * glow + 0.06 * glow;
      A += (c[1] - A) * glow;
      B += (c[2] - B) * glow;
    }
    return oklabToLinear(L, A, B);
  },
};

export const LIGHT_STYLES = { silk, waves, aurora };
```

- [ ] **Step 4: Run the test, lint and typecheck**

Run: `bun test test/styles-light.test.ts && bunx biome check src test && bunx tsc --noEmit`
Expected: PASS (3 styles × 8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backdrops/styles/light.ts test/styles-light.test.ts
git commit -m "feat(backdrops): silk, waves and aurora styles"
```

---

### Task 4: Pattern styles (stripes, ripple)

**Files:**
- Create: `src/backdrops/styles/pattern.ts`
- Test: `test/styles-pattern.test.ts`

**Interfaces:**
- Consumes (Task 1): `StyleDef`, `Vec3`; `mixLab`; `fbm`, `rand`, `smoothstep`, `TAU`, `tri`; `along`, `across`; `describeStyle`.
- Produces: `export const PATTERN_STYLES: { stripes: StyleDef; ripple: StyleDef }`.

- [ ] **Step 1: Write the failing test**

`test/styles-pattern.test.ts`:

```ts
import { PATTERN_STYLES } from "../src/backdrops/styles/pattern.js";
import { describeStyle } from "./style-helpers.js";

for (const [name, style] of Object.entries(PATTERN_STYLES)) describeStyle(name, style);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/styles-pattern.test.ts`
Expected: FAIL with `Cannot find module '../src/backdrops/styles/pattern.js'`.

- [ ] **Step 3: Write the styles**

`src/backdrops/styles/pattern.ts`:

```ts
import { mixLab } from "../color.js";
import { fbm, rand, smoothstep, TAU, tri } from "../noise.js";
import { across, along } from "../space.js";
import type { StyleDef, Vec3 } from "../types.js";

const stripes: StyleDef = {
  description: "crisp diagonal bands with soft edges and depth shading",
  colors: ["#1b1033", "#ff5e62", "#ff9966"],
  shade(u, v, t, p) {
    const a = TAU * t;
    const s = along(u, v, p);
    const q = across(u, v, p);
    const bend = 0.6 * p.distortion * (fbm(p.seed, q * 0.7 + 0.3 * p.speed * Math.cos(a), s * 0.7, 2) - 0.5);
    const pos = (q + bend + 0.12 * p.speed * Math.sin(a)) * 3.2;
    const i = Math.floor(pos);
    const f = pos - i;
    const n = p.lab.length;
    const here = p.lab[((i % n) + n) % n] as Vec3;
    const next = p.lab[(((i + 1) % n) + n) % n] as Vec3;
    const edge = smoothstep(0.9, 1, f);
    return mixLab(here, next, edge, 0.72 + 0.38 * f * (1 - edge)); // each band brightens towards its far edge
  },
};

const ripple: StyleDef = {
  description: "zig-zag interference ripples",
  colors: ["#03045e", "#0077b6", "#90e0ef"],
  shade(u, v, t, p) {
    const a = TAU * t;
    const s = along(u, v, p);
    const q = across(u, v, p);
    const zig = 0.18 * tri(q * 1.4);
    const cq = (rand(p.seed, 1) - 0.5) * p.uMax;
    const cs = (rand(p.seed, 2) - 0.5) * p.vMax;
    const r = Math.hypot(q - cq, s - cs);
    const nx = q * 0.8 + 0.3 * p.speed * Math.cos(a);
    const ny = s * 0.8 + 0.3 * p.speed * Math.sin(a);
    const warp = 0.5 * p.distortion * (fbm(p.seed, nx, ny, 2) - 0.5);
    const w1 = tri((s + zig + warp) * 4 + 0.25 * p.speed * Math.sin(a));
    const w2 = tri((r + warp) * 3 - 0.25 * p.speed * Math.sin(a));
    const f = (0.5 * w1 + 0.5 * w2) * (p.lab.length - 1);
    const i = Math.min(p.lab.length - 2, Math.floor(f));
    return mixLab(p.lab[i] as Vec3, p.lab[i + 1] as Vec3, f - i, 0.8 + 0.2 * w1);
  },
};

export const PATTERN_STYLES = { stripes, ripple };
```

- [ ] **Step 4: Run the test, lint and typecheck**

Run: `bun test test/styles-pattern.test.ts && bunx biome check src test && bunx tsc --noEmit`
Expected: PASS (2 styles × 8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backdrops/styles/pattern.ts test/styles-pattern.test.ts
git commit -m "feat(backdrops): stripes and ripple styles"
```

---

### Task 5: Style registry, the `shader` backdrop schema, presets and looks

**Files:**
- Create: `src/backdrops/index.ts`, `src/backdrops/presets.ts`, `src/editor/protocol.ts`
- Modify: `src/schema.ts` (import at line 1; `BackdropSchema` at lines 92–104), `src/looks.ts` (whole file), `test/schema.test.ts:72`
- Test: `test/backdrops.test.ts`

**Interfaces:**
- Consumes: Task 1 (`types`, `color`, `field`, `post`), Tasks 2–4 (`CLASSIC_STYLES`, `LIGHT_STYLES`, `PATTERN_STYLES`), `test/style-helpers.ts` (`mad`).
- Produces (exact):
  - `src/schema.ts`: a fifth `BackdropSchema` variant `{ type: "shader", style: StyleName, colors?: string[] (2–5), angle, scale, distortion, seed, grain, vignette, motion: { enabled, speed } }` with the spec's ranges and defaults; `type ShaderBackdrop = Extract<Backdrop, { type: "shader" }>`.
  - `src/backdrops/index.ts`: `STYLES: Record<StyleName, StyleDef>`, re-exports `STYLE_NAMES` and `StyleName`, `shaderColors(bd: ShaderBackdrop): string[]`, `styleParams(bd: ShaderBackdrop, w: number, h: number): StyleParams`, `shaderField(bd: ShaderBackdrop, w, h, t, out?): Uint8ClampedArray` (field + vignette, no grain).
  - `src/backdrops/presets.ts`: `interface BackdropPreset { description: string; backdrop: Backdrop }`, `HERO_BACKDROP: Backdrop`, `BACKDROPS: Record<string, BackdropPreset>` (19 names, descriptions start with `"<style or type>: "`).
  - `src/looks.ts`: `LOOKS` (unchanged values), `LOOK_DESCRIPTIONS: Record<"hero" | "flat", string>`, `resolveLook(look: string | Look): Look` — look presets, then backdrop presets (`{ ...LOOKS.hero, preset: name, backdrop }`), then error `unknown look "x" (looks: hero, flat; backdrops: ultraviolet, …). Run camerawork looks …`; a look object is validated and its shader `colors` filled in.
  - `src/editor/protocol.ts` (the server ↔ page contract for Tasks 8 and 9): `EDITOR_ASSETS = ["index.html", "editor.js", "editor.css"] as const`; `interface LookInfo { look: Look; window: { width: number; height: number; duration: number }; hasMaster: boolean; out: string }`; `type SaveReply = { saved: string } | { error: string }`; `HEARTBEAT_MS = 5000`. Endpoints: `GET /`, `GET /editor.js`, `GET /editor.css`, `GET /look` → `LookInfo`, `GET /frame?t=<s>` → JPEG (master) or PNG (placeholder), `POST /save` (JSON look) → `SaveReply`, `POST /heartbeat` → 204, `POST /bye` → 204.

`src/backdrops/index.ts` and `presets.ts` import `../schema.js` with `import type` only (they are bundled into the page). `schema.ts` imports the runtime `STYLE_NAMES` from `./backdrops/types.js`, which imports nothing, so there is no import cycle.

- [ ] **Step 1: Write the failing tests**

`test/backdrops.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { STYLE_NAMES, STYLES, shaderColors, shaderField, styleParams } from "../src/backdrops/index.js";
import { BACKDROPS } from "../src/backdrops/presets.js";
import { CameraworkError, parseWith } from "../src/errors.js";
import { LOOK_DESCRIPTIONS, LOOKS, resolveLook } from "../src/looks.js";
import { BackdropSchema, LookSchema, type ShaderBackdrop } from "../src/schema.js";
import { mad } from "./style-helpers.js";

const shader = (more: Record<string, unknown> = {}): ShaderBackdrop =>
  parseWith(BackdropSchema, { type: "shader", style: "silk", ...more }, "backdrop") as ShaderBackdrop;

describe("style registry", () => {
  test("has every style named in the schema", () => {
    expect(Object.keys(STYLES).sort()).toEqual([...STYLE_NAMES].sort());
  });

  test("every style looks different from every other with the same palette", () => {
    const colors = ["#101828", "#7b2bff", "#ff2bd6", "#fde68a"];
    const fields = STYLE_NAMES.map((style) => shaderField(shader({ style, colors, grain: 0 }), 160, 90, 0));
    for (let i = 0; i < fields.length; i++)
      for (let j = i + 1; j < fields.length; j++)
        expect(mad(fields[i] as Uint8ClampedArray, fields[j] as Uint8ClampedArray)).toBeGreaterThan(4);
  });

  test("styleParams: style palette by default, speed 0 without motion, an unsigned seed, the field's extent", () => {
    const bd = shader({ seed: -1 });
    expect(shaderColors(bd)).toEqual(STYLES.silk.colors);
    const p = styleParams(bd, 200, 100);
    expect(p.lab).toHaveLength(3);
    expect(p.speed).toBe(0);
    expect(p.seed).toBe(4294967295);
    expect([p.uMax, p.vMax]).toEqual([2, 1]);
    expect(styleParams(shader({ motion: { enabled: true, speed: 0.7 } }), 100, 100).speed).toBe(0.7);
  });

  test("shaderField applies the vignette and is deterministic", () => {
    const plain = shaderField(shader({ vignette: 0 }), 160, 90, 0);
    const dark = shaderField(shader({ vignette: 1 }), 160, 90, 0);
    expect(dark[0] as number).toBeLessThan(plain[0] as number);
    expect(Buffer.from(plain).equals(Buffer.from(shaderField(shader({ vignette: 0 }), 160, 90, 0)))).toBe(true);
  });
});

describe("shader backdrops in the look file", () => {
  test("defaults follow the spec", () => {
    const bd = shader();
    expect(bd).toEqual({
      type: "shader",
      style: "silk",
      angle: 45,
      scale: 1,
      distortion: 0.3,
      seed: 1,
      grain: 0.04,
      vignette: 0,
      motion: { enabled: false, speed: 0.3 },
    });
  });

  test("invalid settings are CameraworkErrors naming the field", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ style: "plaid" }, "backdrop.style"],
      [{ colors: ["#000000"] }, "backdrop.colors"],
      [{ colors: ["#000000", "#111111", "#222222", "#333333", "#444444", "#555555"] }, "backdrop.colors"],
      [{ colors: ["#000000", "red"] }, "backdrop.colors.1"],
      [{ angle: 400 }, "backdrop.angle"],
      [{ scale: 0.1 }, "backdrop.scale"],
      [{ distortion: 2 }, "backdrop.distortion"],
      [{ seed: 1.5 }, "backdrop.seed"],
      [{ grain: 0.5 }, "backdrop.grain"],
      [{ vignette: -1 }, "backdrop.vignette"],
      [{ motion: { enabled: true, speed: 3 } }, "backdrop.motion.speed"],
      [{ sparkle: true }, "backdrop"],
    ];
    for (const [more, field] of cases) {
      const look = { ...LOOKS.hero, backdrop: { type: "shader", style: "silk", ...more } };
      expect(() => resolveLook(look as never)).toThrow(CameraworkError);
      expect(() => resolveLook(look as never)).toThrow(`${field}:`);
    }
  });

  test("a look file without colours gets its style's palette", () => {
    const look = resolveLook({ ...LOOKS.hero, backdrop: { type: "shader", style: "waves" } } as never);
    expect(look.backdrop).toMatchObject({ type: "shader", style: "waves", colors: STYLES.waves.colors });
  });
});

describe("backdrop presets", () => {
  test("every preset is a valid backdrop with a description", () => {
    expect(Object.keys(BACKDROPS).length).toBeGreaterThanOrEqual(16);
    for (const [name, preset] of Object.entries(BACKDROPS)) {
      expect(BackdropSchema.safeParse(preset.backdrop).success).toBe(true);
      expect(preset.description).toMatch(/^[a-z]+: /);
      expect(LookSchema.safeParse(resolveLook(name)).success).toBe(true);
    }
  });

  test("the spec's presets exist and every style has at least one", () => {
    for (const name of [
      "ultraviolet",
      "glacier",
      "aurora",
      "dusk",
      "midnight",
      "petal",
      "ripple-sea",
      "ember",
      "solar",
      "raspberry",
      "frost",
      "chrome",
      "graphite",
      "hero",
      "solid",
      "none",
    ])
      expect(Object.hasOwn(BACKDROPS, name)).toBe(true);
    const styles = new Set(
      Object.values(BACKDROPS).flatMap((p) => (p.backdrop.type === "shader" ? [p.backdrop.style] : [])),
    );
    expect([...styles].sort()).toEqual([...STYLE_NAMES].sort());
  });

  test("--look <backdrop preset> is the hero window on that backdrop", () => {
    const look = resolveLook("ultraviolet");
    expect(look.preset).toBe("ultraviolet");
    expect(look.backdrop).toEqual(BACKDROPS.ultraviolet?.backdrop as ShaderBackdrop);
    expect({ ...look, preset: "hero", backdrop: LOOKS.hero.backdrop }).toEqual(LOOKS.hero);
    look.padding = 0.3;
    expect(resolveLook("ultraviolet").padding).toBe(0.09);
  });

  test("look presets win over backdrop presets of the same name, and both have descriptions", () => {
    expect(resolveLook("hero")).toEqual(LOOKS.hero);
    expect(Object.keys(LOOK_DESCRIPTIONS)).toEqual(Object.keys(LOOKS));
  });
});
```

In `test/schema.test.ts` line 72, the unknown-look message changes. Replace:

```ts
    expect(() => resolveLook("sparkly")).toThrow('unknown look "sparkly" (known: hero, flat)');
```

with:

```ts
    expect(() => resolveLook("sparkly")).toThrow('unknown look "sparkly" (looks: hero, flat; backdrops: ultraviolet');
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test test/backdrops.test.ts test/schema.test.ts`
Expected: FAIL with `Cannot find module '../src/backdrops/index.js'` (and the message test failing).

- [ ] **Step 3: Add the `shader` variant to the schema**

In `src/schema.ts`, after `import { z } from "zod";` add:

```ts
import { STYLE_NAMES } from "./backdrops/types.js";
```

and replace the end of `BackdropSchema` and the `Backdrop` type:

```ts
  z.object({ type: z.literal("none") }).strict(),
]);
export type Backdrop = z.infer<typeof BackdropSchema>;
```

with:

```ts
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("shader"),
      style: z.enum(STYLE_NAMES),
      colors: z.array(color).min(2).max(5).optional(),
      angle: z.number().min(0).max(360).default(45),
      scale: z.number().min(0.2).max(5).default(1),
      distortion: z.number().min(0).max(1).default(0.3),
      seed: z.number().int().default(1),
      grain: z.number().min(0).max(0.3).default(0.04),
      vignette: z.number().min(0).max(1).default(0),
      motion: z
        .object({ enabled: z.boolean().default(false), speed: z.number().min(0.05).max(2).default(0.3) })
        .strict()
        .default({ enabled: false, speed: 0.3 }),
    })
    .strict(),
]);
export type Backdrop = z.infer<typeof BackdropSchema>;
/** A procedural backdrop (spec: backdrops §3). `colors` left out means the style's own palette. */
export type ShaderBackdrop = Extract<Backdrop, { type: "shader" }>;
```

- [ ] **Step 4: Write the registry**

`src/backdrops/index.ts`:

```ts
import type { ShaderBackdrop } from "../schema.js";
import { hexToLinear, linearToOklab } from "./color.js";
import { renderField } from "./field.js";
import { applyVignette } from "./post.js";
import { CLASSIC_STYLES } from "./styles/classic.js";
import { LIGHT_STYLES } from "./styles/light.js";
import { PATTERN_STYLES } from "./styles/pattern.js";
import type { StyleDef, StyleName, StyleParams } from "./types.js";

export { STYLE_NAMES, type StyleName } from "./types.js";

/** Every background style by name (spec: backdrops §2). */
export const STYLES: Record<StyleName, StyleDef> = { ...LIGHT_STYLES, ...PATTERN_STYLES, ...CLASSIC_STYLES };

/** The backdrop's colours, or its style's palette when it gives none. */
export const shaderColors = (bd: ShaderBackdrop): string[] => bd.colors ?? STYLES[bd.style].colors;

/** Resolves a shader backdrop's settings for a w×h field. */
export function styleParams(bd: ShaderBackdrop, w: number, h: number): StyleParams {
  const rad = (bd.angle * Math.PI) / 180;
  const short = Math.min(w, h);
  return {
    lab: shaderColors(bd).map((c) => linearToOklab(hexToLinear(c))),
    sin: Math.sin(rad),
    cos: Math.cos(rad),
    scale: bd.scale,
    distortion: bd.distortion,
    seed: bd.seed >>> 0,
    speed: bd.motion.enabled ? bd.motion.speed : 0,
    uMax: w / short,
    vMax: h / short,
  };
}

/**
 * The backdrop as opaque RGBA bytes, w×h, at loop time t (0 for a still), vignette included. Grain is not: it is
 * added at full size by whoever shows the result (spec: backdrops §2, §4).
 */
export function shaderField(
  bd: ShaderBackdrop,
  w: number,
  h: number,
  t: number,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const px = renderField(STYLES[bd.style].shade, styleParams(bd, w, h), w, h, t, out);
  applyVignette(px, w, h, bd.vignette);
  return px;
}
```

- [ ] **Step 5: Write the presets**

`src/backdrops/presets.ts` (palettes checked by eye in a contact sheet while planning):

```ts
import type { Backdrop, ShaderBackdrop } from "../schema.js";
import type { StyleName } from "./types.js";

export interface BackdropPreset {
  /** "<style>: <what it looks like>", shown by `camerawork looks` and the editor. */
  description: string;
  backdrop: Backdrop;
}

/** The `hero` look's measured gradient (ruling R2 of the engine plan). */
export const HERO_BACKDROP: Backdrop = {
  type: "gradient",
  angle: 180,
  stops: [
    { at: 0, color: "#8f8f8f" },
    { at: 0.27, color: "#c4c4c4" },
    { at: 0.42, color: "#1a1a1a" },
    { at: 1, color: "#0e0e0e" },
  ],
};

const shader = (
  style: StyleName,
  colors: string[],
  angle: number,
  more: Partial<Omit<ShaderBackdrop, "type" | "style" | "colors" | "angle">> = {},
): ShaderBackdrop => ({
  type: "shader",
  style,
  colors,
  angle,
  scale: 1,
  distortion: 0.35,
  seed: 1,
  grain: 0.05,
  vignette: 0.15,
  motion: { enabled: false, speed: 0.3 },
  ...more,
});

/** Named backdrops. `--look <name>` puts the hero window (padding, radius, shadow) on one of these. */
export const BACKDROPS: Record<string, BackdropPreset> = {
  ultraviolet: {
    description: "silk: deep violet folds with a magenta sheen",
    backdrop: shader("silk", ["#12002e", "#7b2bff", "#ff2bd6"], 62, { distortion: 0.4, seed: 7, vignette: 0.2 }),
  },
  glacier: {
    description: "silk: icy blue folds",
    backdrop: shader("silk", ["#03142b", "#2b6cb0", "#bfe9ff"], 120, { seed: 3 }),
  },
  raspberry: {
    description: "silk: dark berry folds with pink light",
    backdrop: shader("silk", ["#2a0010", "#c2185b", "#ff8fb1"], 35, { seed: 11 }),
  },
  frost: {
    description: "silk: pale silver-blue folds (a light backdrop)",
    backdrop: shader("silk", ["#dbe6f0", "#eef3f8", "#ffffff"], 140, { seed: 5, grain: 0.03, vignette: 0 }),
  },
  chrome: {
    description: "silk: polished metal grays",
    backdrop: shader("silk", ["#0b0b0c", "#55575c", "#e4e6ea"], 75, { seed: 9, distortion: 0.5 }),
  },
  aurora: {
    description: "aurora: cyan, violet and green ribbons on a night sky",
    backdrop: shader("aurora", ["#020617", "#22d3ee", "#a855f7", "#4ade80"], 20, {
      seed: 4,
      distortion: 0.5,
      vignette: 0.25,
    }),
  },
  dusk: {
    description: "stripes: sunset bands of coral and orange",
    backdrop: shader("stripes", ["#1b1033", "#ff5e62", "#ff9966"], 55, { seed: 2 }),
  },
  midnight: {
    description: "stripes: deep blue bands",
    backdrop: shader("stripes", ["#050816", "#1e3a8a", "#312e81"], 140, { seed: 6, vignette: 0.3 }),
  },
  ember: {
    description: "stripes: glowing red, orange and gold bands",
    backdrop: shader("stripes", ["#140400", "#b91c1c", "#f97316", "#fbbf24"], 30, { seed: 8 }),
  },
  graphite: {
    description: "stripes: quiet dark-gray bands",
    backdrop: shader("stripes", ["#0e0e0f", "#26272b", "#45474d"], 60, { seed: 12, grain: 0.06 }),
  },
  petal: {
    description: "mesh: soft pink, lilac and peach blobs",
    backdrop: shader("mesh", ["#ff9a9e", "#fecfef", "#a18cd1", "#fbc2eb", "#f6d365"], 45, {
      seed: 21,
      grain: 0.04,
      vignette: 0,
    }),
  },
  "ripple-sea": {
    description: "ripple: blue zig-zag water",
    backdrop: shader("ripple", ["#03045e", "#0077b6", "#90e0ef"], 15, { seed: 13 }),
  },
  solar: {
    description: "waves: warm layered dunes",
    backdrop: shader("waves", ["#2b0a00", "#c2410c", "#f59e0b", "#fde68a"], 10, { seed: 14 }),
  },
  horizon: {
    description: "linear: night sky fading to day",
    backdrop: shader("linear", ["#0f172a", "#1e40af", "#7dd3fc"], 180, { distortion: 0.2 }),
  },
  halo: {
    description: "radial: a warm glow behind the window",
    backdrop: shader("radial", ["#fff1c1", "#f97316", "#1c0a00"], 0, { scale: 1.2, distortion: 0.2, vignette: 0 }),
  },
  prism: {
    description: "conic: a colour wheel sweep",
    backdrop: shader("conic", ["#6d28d9", "#ec4899", "#f59e0b", "#06b6d4"], 30, { distortion: 0.2 }),
  },
  hero: { description: "gradient: the hero look's gray sky-to-ground gradient", backdrop: HERO_BACKDROP },
  solid: { description: "solid: plain near-black", backdrop: { type: "solid", color: "#0e0e0e" } },
  none: { description: "none: black around the window", backdrop: { type: "none" } },
};
```

- [ ] **Step 6: Resolve backdrop presets as looks**

Replace `src/looks.ts` with:

```ts
import { shaderColors } from "./backdrops/index.js";
import { BACKDROPS, type BackdropPreset, HERO_BACKDROP } from "./backdrops/presets.js";
import { CameraworkError, parseWith } from "./errors.js";
import { type Look, LookSchema } from "./schema.js";

/** Built-in looks. Lengths are pixels at a 1920-px-wide window (ruling R1). */
export const LOOKS = {
  // Measured from the JSLab hero (ruling R2): padding 0.09, radius 18, no tilt, a gray sky-to-ground gradient.
  hero: {
    preset: "hero",
    backdrop: HERO_BACKDROP,
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

/** One line per built-in look, for `camerawork looks`. */
export const LOOK_DESCRIPTIONS: Record<keyof typeof LOOKS, string> = {
  hero: "gray gradient backdrop, 9 % padding, rounded corners, soft shadow",
  flat: "the window alone: no backdrop, padding, rounding or shadow",
};

/** Fills in the palette a shader backdrop left out, so a plan records the backdrop in full (spec: backdrops §3). */
function complete(look: Look): Look {
  const bd = look.backdrop;
  return bd.type === "shader" && !bd.colors ? { ...look, backdrop: { ...bd, colors: [...shaderColors(bd)] } } : look;
}

/**
 * A look preset by name (a fresh copy); a backdrop preset by name, which is the hero window on that backdrop; or a
 * look object, validated against the schema.
 */
export function resolveLook(look: string | Look): Look {
  if (typeof look !== "string") return complete(parseWith(LookSchema, look, "look"));
  if (Object.hasOwn(LOOKS, look)) return structuredClone((LOOKS as Record<string, Look>)[look] as Look);
  if (Object.hasOwn(BACKDROPS, look))
    return {
      ...structuredClone(LOOKS.hero),
      preset: look,
      backdrop: structuredClone((BACKDROPS[look] as BackdropPreset).backdrop),
    };
  throw new CameraworkError(
    `unknown look "${look}" (looks: ${Object.keys(LOOKS).join(", ")}; backdrops: ${Object.keys(BACKDROPS).join(", ")}). ` +
      "Run camerawork looks to see them, or pass a look .json file.",
  );
}
```

- [ ] **Step 7: Write the editor protocol**

`src/editor/protocol.ts`:

```ts
import type { Look } from "../schema.js";

/** The files the editor page is built into (dist/editor/), served by the editor server at `/<name>`. */
export const EDITOR_ASSETS = ["index.html", "editor.js", "editor.css"] as const;

/** GET /look: the starting look and the window the preview shows. */
export interface LookInfo {
  look: Look;
  /** The master's size and duration, or the neutral placeholder's (1920×1080, 10 s) without --master. */
  window: { width: number; height: number; duration: number };
  hasMaster: boolean;
  /** The absolute path Save writes. */
  out: string;
}

/** POST /save (body: a Look as JSON, Content-Type application/json): 200 with `{ saved }`, or 400 with `{ error }`. */
export type SaveReply = { saved: string } | { error: string };

/** The page posts a heartbeat this often; the server ends an unsaved session after `idleMs` without one. */
export const HEARTBEAT_MS = 5000;
```

- [ ] **Step 8: Run the tests, the whole suite, lint and typecheck**

Run: `bun test test/backdrops.test.ts test/schema.test.ts && bun run test && bunx biome check . && bunx tsc --noEmit`
Expected: PASS (21 tests in the two files; the full suite stays green: `plan()` and `render()` still use `hero` by default).

- [ ] **Step 9: Commit**

```bash
git add src/backdrops/index.ts src/backdrops/presets.ts src/editor/protocol.ts src/schema.ts src/looks.ts test/backdrops.test.ts test/schema.test.ts
git commit -m "feat(looks): shader backdrops in the look file, 19 backdrop presets, --look <backdrop preset>"
```

---

### Task 6: Rendering shader backdrops in Node (still canvas, worker frames, intermediate video)

**Files:**
- Create: `src/render/backdrop.ts`, `src/render/backdrop-frames.ts`, `src/render/backdrop-worker.ts`
- Test: `test/backdrop-render.test.ts`

**Interfaces:**
- Consumes: Task 1 (`fieldSize`, `applyGrain`, `grainCell`), Task 5 (`shaderField`, `BACKDROPS`, `ShaderBackdrop`), `FrameSink`, `probe`, `readFrames` from `src/ffmpeg.ts`, `tmpDir` from `test/helpers.ts`, `mad` from `test/style-helpers.ts`.
- Produces (exact):
  - `backdrop.ts`: `interface BackdropMotion { grain: number; seed: number; cell: number }`; `shaderCanvas(bd: ShaderBackdrop, w: number, h: number, t = 0): Canvas` (field ≤ 1280 → Skia "high" upscale → grain at full size); `motionFrameCount(duration: number, fps: number): number` (≥ 1); `intermediateArgs(w, h, fps, out): string[]`; `renderBackdropVideo(bd, sceneW, sceneH, fps, duration, out): Promise<BackdropMotion>`; `motionFilter(sceneW, sceneH, m: BackdropMotion): string` (ffmpeg filters: upscale + per-frame grain).
  - `backdrop-frames.ts`: `interface FrameJob { bd: ShaderBackdrop; w: number; h: number; frame: number; frames: number }`, `interface FrameDone { frame: number; px: Uint8ClampedArray }`, `backdropThreads(): number`, `renderFrames(bd, w, h, frames, onFrame: (index, px) => void | Promise<void>, threads = backdropThreads()): Promise<void>` (in order, bounded memory, rejects on a worker or `onFrame` failure).
  - `backdrop-worker.ts`: worker entry (no exports).

Workers: Bun (tests) runs `backdrop-worker.ts`; Node runs the compiled `dist/render/backdrop-worker.js`. `renderFrames` picks the extension from `import.meta.url`.

- [ ] **Step 1: Write the failing tests**

`test/backdrop-render.test.ts` (the "huge master" tests pin Review Focus 1; `motionFrameCount` and the 1-frame loop pin Review Focus 3):

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fieldSize } from "../src/backdrops/field.js";
import { shaderField } from "../src/backdrops/index.js";
import { BACKDROPS } from "../src/backdrops/presets.js";
import { probe, readFrames } from "../src/ffmpeg.js";
import { motionFilter, motionFrameCount, renderBackdropVideo, shaderCanvas } from "../src/render/backdrop.js";
import { renderFrames } from "../src/render/backdrop-frames.js";
import type { ShaderBackdrop } from "../src/schema.js";
import { tmpDir } from "./helpers.js";
import { mad } from "./style-helpers.js";

const ultraviolet = BACKDROPS.ultraviolet?.backdrop as ShaderBackdrop;
const moving = (more: Partial<ShaderBackdrop> = {}): ShaderBackdrop => ({
  ...ultraviolet,
  grain: 0,
  motion: { enabled: true, speed: 1 },
  ...more,
});

/** Every frame of a video as RGBA. */
async function decode(path: string, w: number, h: number): Promise<Uint8ClampedArray[]> {
  const frames: Uint8ClampedArray[] = [];
  await readFrames(["-i", path, "-pix_fmt", "rgba"], w * h * 4, (f) => {
    frames.push(new Uint8ClampedArray(Buffer.from(f)));
  });
  return frames;
}

describe("still shader backdrops", () => {
  test("shaderCanvas has the requested size, is deterministic, and its grain is crisp", () => {
    const a = shaderCanvas(ultraviolet, 640, 360).data();
    expect(a.length).toBe(640 * 360 * 4);
    expect(a.equals(shaderCanvas(ultraviolet, 640, 360).data())).toBe(true);
    const smooth = shaderCanvas({ ...ultraviolet, grain: 0 }, 640, 360).data();
    let jumps = 0;
    for (let i = 4; i < 640 * 4; i += 4) {
      if (Math.abs((a[i] as number) - (a[i - 4] as number)) > 3) jumps++;
      expect(Math.abs((smooth[i] as number) - (smooth[i - 4] as number))).toBeLessThanOrEqual(3);
    }
    expect(jumps).toBeGreaterThan(100);
  });

  test("a huge master's scene (8K) renders from a ≤1280-px field without running out of memory (Review Focus 1)", () => {
    const before = process.memoryUsage().rss;
    const canvas = shaderCanvas(ultraviolet, 9368, 5272);
    expect([canvas.width, canvas.height]).toEqual([9368, 5272]);
    expect(fieldSize(9368, 5272)).toEqual([1280, 720]);
    // the scene canvas and one getImageData copy: about 2 × 198 MB
    expect(process.memoryUsage().rss - before).toBeLessThan(1.2e9);
  }, 60_000);
});

describe("animated shader backdrops", () => {
  test("motionFrameCount: duration × fps, at least one frame (Review Focus 3)", () => {
    expect(motionFrameCount(2, 30)).toBe(60);
    expect(motionFrameCount(0.01, 30)).toBe(1);
    expect(motionFrameCount(1.49, 2)).toBe(3);
  });

  test("renderFrames returns every frame, in order, equal to the field at t = i / frames", async () => {
    const bd = moving();
    for (const threads of [1, 3]) {
      const seen: number[] = [];
      await renderFrames(
        bd,
        64,
        36,
        7,
        (i, px) => {
          seen.push(i);
          expect(Buffer.from(px).equals(Buffer.from(shaderField(bd, 64, 36, i / 7)))).toBe(true);
        },
        threads,
      );
      expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  test("renderFrames rejects when a worker fails, and when onFrame fails", async () => {
    const broken = { ...moving(), style: "plaid" } as unknown as ShaderBackdrop;
    await expect(renderFrames(broken, 16, 16, 3, () => {})).rejects.toThrow();
    await expect(
      renderFrames(moving(), 16, 16, 3, () => {
        throw new Error("sink died");
      }),
    ).rejects.toThrow("sink died");
  });

  test("the intermediate video is field-sized, one loop long, and loops seamlessly", async () => {
    const dir = tmpDir();
    const out = join(dir, "backdrop.mp4");
    const motion = await renderBackdropVideo(moving(), 640, 360, 30, 1, out);
    expect(motion).toEqual({ grain: 0, seed: 7, cell: 1 });
    const info = probe(out);
    expect([info.width, info.height]).toEqual([640, 360]);
    const frames = await decode(out, 640, 360);
    expect(frames).toHaveLength(30);
    const steps = frames.map((f, i) => mad(f, frames[(i + 1) % 30] as Uint8ClampedArray));
    expect(steps[29] as number).toBeLessThanOrEqual(Math.max(...steps.slice(0, 29)) * 1.1 + 0.3);
    expect(mad(frames[0] as Uint8ClampedArray, frames[15] as Uint8ClampedArray)).toBeGreaterThan(2);
  }, 60_000);

  test("a huge scene still gets a ≤1280-px intermediate, and a 1-frame master a 1-frame loop", async () => {
    const dir = tmpDir();
    const big = join(dir, "big.mp4");
    const motion = await renderBackdropVideo(moving({ grain: 0.05 }), 9368, 5272, 30, 0.1, big);
    expect(probe(big).width).toBe(1280);
    expect(motion.cell).toBe(5);
    const one = join(dir, "one.mp4");
    await renderBackdropVideo(moving(), 640, 360, 30, 0.02, one);
    expect(await decode(one, 640, 360)).toHaveLength(1);
  }, 60_000);

  test("motionFilter: scale, then grain (cells are scaled up with nearest-neighbour)", () => {
    expect(motionFilter(1920, 1080, { grain: 0, seed: 1, cell: 1 })).toBe("scale=1920:1080:flags=bicubic");
    expect(motionFilter(1920, 1080, { grain: 0.05, seed: 3, cell: 1 })).toBe(
      "scale=1920:1080:flags=bicubic,format=yuv444p,noise=c0s=11:c0f=t+u:all_seed=3",
    );
    expect(motionFilter(4688, 2636, { grain: 0.3, seed: -1, cell: 2 })).toBe(
      "scale=2344:1318:flags=bicubic,format=yuv444p,noise=c0s=66:c0f=t+u:all_seed=2147483647," +
        "scale=4688:2636:flags=neighbor",
    );
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test test/backdrop-render.test.ts`
Expected: FAIL with `Cannot find module '../src/render/backdrop.js'`.

- [ ] **Step 3: Write the worker pool and the worker**

`src/render/backdrop-frames.ts`:

```ts
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { ShaderBackdrop } from "../schema.js";

/** One frame for a backdrop worker: frame / frames is the loop time t. */
export interface FrameJob {
  bd: ShaderBackdrop;
  w: number;
  h: number;
  frame: number;
  frames: number;
}

/** A worker's answer: the field's RGBA bytes (their buffer is transferred, not copied). */
export interface FrameDone {
  frame: number;
  px: Uint8ClampedArray;
}

/** Worker threads for animated backdrops: one per core but one, at most 8. */
export const backdropThreads = (): number => Math.min(8, Math.max(1, availableParallelism() - 1));

/**
 * Renders frames 0 … frames-1 of an animated backdrop's field (w×h) on worker threads and hands them to `onFrame`
 * in order, one at a time. Each worker has one frame in flight and at most 2 × threads finished frames wait for
 * `onFrame`, so memory stays at a few fields however long the video is.
 */
export async function renderFrames(
  bd: ShaderBackdrop,
  w: number,
  h: number,
  frames: number,
  onFrame: (index: number, px: Uint8ClampedArray) => void | Promise<void>,
  threads = backdropThreads(),
): Promise<void> {
  // Bun runs the TypeScript sources (tests); Node runs the compiled .js next to this file.
  const url = new URL(`./backdrop-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url);
  const workers = Array.from({ length: Math.max(1, Math.min(threads, frames)) }, () => new Worker(url));
  const limit = 2 * workers.length;
  const ready = new Map<number, Uint8ClampedArray>();
  const idle = [...workers];
  let sent = 0;
  let written = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      let chain = Promise.resolve();
      const pump = () => {
        while (idle.length > 0 && sent < frames && sent - written < limit) {
          const job: FrameJob = { bd, w, h, frame: sent++, frames };
          (idle.pop() as Worker).postMessage(job);
        }
      };
      for (const worker of workers) {
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (written < frames) reject(new Error(`a backdrop worker exited early (code ${code})`));
        });
        worker.on("message", (done: FrameDone) => {
          ready.set(done.frame, done.px);
          idle.push(worker);
          chain = chain
            .then(async () => {
              for (let px = ready.get(written); px; px = ready.get(written)) {
                ready.delete(written);
                await onFrame(written++, px);
              }
              if (written === frames) resolve();
              else pump();
            })
            .catch(reject);
        });
      }
      pump();
    });
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
```

`src/render/backdrop-worker.ts`:

```ts
import { parentPort } from "node:worker_threads";
import { shaderField } from "../backdrops/index.js";
import type { FrameDone, FrameJob } from "./backdrop-frames.js";

// A worker thread started by renderFrames: renders one field per message and transfers its pixels back.
parentPort?.on("message", (job: FrameJob) => {
  const px = shaderField(job.bd, job.w, job.h, job.frame / job.frames);
  const done: FrameDone = { frame: job.frame, px };
  parentPort?.postMessage(done, [px.buffer as ArrayBuffer]);
});
```

- [ ] **Step 4: Write the backdrop renderers**

`src/render/backdrop.ts`:

```ts
import { type Canvas, createCanvas, ImageData } from "@napi-rs/canvas";
import { fieldSize } from "../backdrops/field.js";
import { shaderField } from "../backdrops/index.js";
import { applyGrain, grainCell } from "../backdrops/post.js";
import { FrameSink } from "../ffmpeg.js";
import type { ShaderBackdrop } from "../schema.js";
import { renderFrames } from "./backdrop-frames.js";

/** How the scene graph shows an animated backdrop's intermediate video: upscaled, with grain re-seeded per frame. */
export interface BackdropMotion {
  grain: number;
  seed: number;
  /** Grain cell size in scene pixels (grainCell of the scene width). */
  cell: number;
}

/**
 * A still shader backdrop at w×h (spec: backdrops §4): computed at the reduced field size (≤ 1280 px on the long
 * side, vignette included), upscaled with Skia's high-quality resampling, then grain added at full size.
 */
export function shaderCanvas(bd: ShaderBackdrop, w: number, h: number, t = 0): Canvas {
  const [fw, fh] = fieldSize(w, h);
  const small = createCanvas(fw, fh);
  small.getContext("2d").putImageData(new ImageData(shaderField(bd, fw, fh, t), fw, fh), 0, 0);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small, 0, 0, w, h);
  if (bd.grain > 0) {
    const img = ctx.getImageData(0, 0, w, h);
    applyGrain(img.data, w, h, { grain: bd.grain, seed: bd.seed, frame: 0, cell: grainCell(w) });
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

/** Frames in one loop of an animated backdrop: the master's duration at the output fps, at least 1. */
export const motionFrameCount = (duration: number, fps: number): number => Math.max(1, Math.round(duration * fps));

/** ffmpeg args for the intermediate video: raw RGBA on stdin → H.264 RGB, CRF 12 (near-lossless, fast to write). */
export function intermediateArgs(w: number, h: number, fps: number, out: string): string[] {
  return [
    ...["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps), "-i", "-"],
    ...["-c:v", "libx264rgb", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "rgb24", "-f", "mp4", out],
  ];
}

/**
 * Renders one loop of an animated backdrop (frame i at t = i / frameCount, so the last frame leads straight back to
 * the first) at the field size into `out`. The scene graph upscales it and adds the grain (see motionFilter).
 */
export async function renderBackdropVideo(
  bd: ShaderBackdrop,
  sceneW: number,
  sceneH: number,
  fps: number,
  duration: number,
  out: string,
): Promise<BackdropMotion> {
  const [fw, fh] = fieldSize(sceneW, sceneH);
  const sink = new FrameSink(intermediateArgs(fw, fh, fps, out));
  try {
    await renderFrames(bd, fw, fh, motionFrameCount(duration, fps), (_, px) =>
      sink.write(Buffer.from(px.buffer, px.byteOffset, px.byteLength)),
    );
    await sink.end();
  } catch (error) {
    await sink.kill();
    throw error;
  }
  return { grain: bd.grain, seed: bd.seed, cell: grainCell(sceneW) };
}

/**
 * ffmpeg filters that turn the intermediate video into the scene's backdrop: a bicubic upscale, then monochrome
 * uniform grain (luma noise, re-seeded every frame) sized like applyGrain's. `noise` strength s moves RGB by about
 * ±0.58·s, so s = grain × 220 matches applyGrain's ±grain × 128.
 */
export function motionFilter(sceneW: number, sceneH: number, m: BackdropMotion): string {
  const full = `scale=${sceneW}:${sceneH}:flags=bicubic`;
  const strength = Math.min(100, Math.round(m.grain * 220));
  if (strength === 0) return full;
  const noise = `format=yuv444p,noise=c0s=${strength}:c0f=t+u:all_seed=${m.seed & 0x7fffffff}`;
  if (m.cell <= 1) return `${full},${noise}`;
  const gw = Math.ceil(sceneW / m.cell);
  const gh = Math.ceil(sceneH / m.cell);
  return `scale=${gw}:${gh}:flags=bicubic,${noise},scale=${sceneW}:${sceneH}:flags=neighbor`;
}
```

- [ ] **Step 5: Run the tests, lint and typecheck**

Run: `bun test test/backdrop-render.test.ts && bunx biome check . && bunx tsc --noEmit`
Expected: PASS (8 tests; the two huge-scene tests take a few seconds each).

- [ ] **Step 6: Check the compiled worker under Node**

Run: `bunx tsc -p tsconfig.build.json && node -e "import('./dist/render/backdrop-frames.js').then(async (m) => { const bd = { type: 'shader', style: 'silk', angle: 45, scale: 1, distortion: 0.3, seed: 1, grain: 0, vignette: 0, motion: { enabled: true, speed: 1 } }; let n = 0; await m.renderFrames(bd, 64, 36, 5, () => { n++; }); console.log('frames', n); })"`
Expected: `frames 5`.

- [ ] **Step 7: Commit**

```bash
git add src/render/backdrop.ts src/render/backdrop-frames.ts src/render/backdrop-worker.ts test/backdrop-render.test.ts
git commit -m "feat(render): shader backdrop stills, worker-rendered motion loops and their ffmpeg filter"
```

---

### Task 7: Shader backdrops in the scene graph, render and preview

**Files:**
- Modify: `src/render/assets.ts` (whole file), `src/render/scene.ts` (whole file), `src/render/index.ts:73`, `src/preview.ts:57`
- Test: `test/shader-scene.test.ts`

**Interfaces:**
- Consumes: Task 1 (`gradientLine`), Task 5 (`resolveLook`, `LOOKS`, `ShaderBackdrop`), Task 6 (`BackdropMotion`, `shaderCanvas`, `renderBackdropVideo`, `motionFilter`).
- Produces (exact):
  - `assets.ts`: `interface LookAssets { backdrop: string; motion: BackdropMotion | null; mask: string | null; shadow: string | null; shadowX: number; shadowY: number }`; `interface LookTiming { fps: number; duration: number }`; `backdropCanvas(bd: Backdrop, w: number, h: number): Promise<Canvas>` (any backdrop type; Task 11's contact sheet uses it); `makeLookAssets(layout, look, workDir, timing?: LookTiming): Promise<LookAssets>`.
  - `scene.ts`: `sceneArgs` unchanged in signature; with `assets.motion` the backdrop input is `-stream_loop -1 -i <video>` and its chain is `[1:v]fps=F,<motionFilter>,format=rgba[bg]`.
  - `render()` and `preview()` pass `{ fps: plan.output.fps, duration: plan.master.duration }`, so animated backdrops move in renders and in the debug video.

- [ ] **Step 1: Write the failing tests**

`test/shader-scene.test.ts` (scene-graph input selection, the spec §8 integration colour check, a `plan.json` round trip, motion in render and debug video, and Review Focus 3):

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFrames } from "../src/ffmpeg.js";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS, resolveLook } from "../src/looks.js";
import { plan, readPlan, writeJsonAtomic } from "../src/plan/index.js";
import { preview } from "../src/preview.js";
import { type LookAssets, makeLookAssets } from "../src/render/assets.js";
import { render } from "../src/render/index.js";
import { sceneArgs } from "../src/render/scene.js";
import type { Look } from "../src/schema.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

const layout = sceneLayout({ width: 640, height: 360 }, LOOKS.hero, 16 / 9);
const base: LookAssets = { backdrop: "/w/bd", motion: null, mask: "/w/mask.png", shadow: null, shadowX: 0, shadowY: 0 };

/** The hero window on a left-to-right red → blue linear backdrop with no noise, grain or vignette. */
const redBlue = (motion = false): Look =>
  resolveLook({
    ...LOOKS.hero,
    backdrop: {
      type: "shader",
      style: "linear",
      colors: ["#ff0000", "#0000ff"],
      angle: 90,
      distortion: motion ? 0.6 : 0,
      grain: 0,
      motion: { enabled: motion, speed: 2 },
    },
  } as Look);

/** RGB of pixel (x, y) in frame `index` of a video, w×h. */
async function pixelAt(video: string, index: number, w: number, h: number, x: number, y: number) {
  let rgb: number[] = [];
  await readFrames(["-i", video, "-pix_fmt", "rgb24"], w * h * 3, (f, i) => {
    if (i === index) rgb = [...f.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
  });
  return rgb;
}

describe("scene graph input selection", () => {
  test("a still backdrop is a looped image", () => {
    const args = sceneArgs("/m.mp4", layout, base, 30);
    expect(args.slice(2, 8)).toEqual(["-loop", "1", "-framerate", "30", "-i", "/w/bd"]);
    expect(args.join(" ")).toContain("[1:v]format=rgba[bg]");
    expect(args).not.toContain("-stream_loop");
  });

  test("an animated backdrop is its intermediate video, looped, upscaled and grained", () => {
    const args = sceneArgs("/m.mp4", layout, { ...base, motion: { grain: 0.05, seed: 7, cell: 1 } }, 30);
    expect(args.slice(2, 6)).toEqual(["-stream_loop", "-1", "-i", "/w/bd"]);
    const graph = args[args.indexOf("-filter_complex") + 1] as string;
    expect(graph).toContain(
      `[1:v]fps=30,scale=${layout.sceneW}:${layout.sceneH}:flags=bicubic,format=yuv444p,noise=c0s=11:c0f=t+u:all_seed=7,format=rgba[bg]`,
    );
  });
});

describe("look assets for shader backdrops", () => {
  test("still → backdrop.png; motion with timing → backdrop.mp4; motion without timing → a still", async () => {
    const dir = tmpDir();
    const still = await makeLookAssets(layout, redBlue(false), dir, { fps: 30, duration: 1 });
    expect([still.backdrop, still.motion]).toEqual([join(dir, "backdrop.png"), null]);
    const moving = await makeLookAssets(layout, redBlue(true), dir, { fps: 30, duration: 1 });
    expect(moving.backdrop).toBe(join(dir, "backdrop.mp4"));
    expect(moving.motion).toEqual({ grain: 0, seed: 1, cell: 1 });
    expect(existsSync(moving.backdrop)).toBe(true);
    expect((await makeLookAssets(layout, redBlue(true), tmpDir())).motion).toBeNull();
  }, 60_000);

  test("no backdrop work when the window covers the scene", async () => {
    const look = { ...redBlue(true), padding: 0, radius: 0, shadow: { blur: 0, offsetY: 0, opacity: 0 } };
    const flatLayout = sceneLayout({ width: 640, height: 360 }, look, 16 / 9);
    const dir = tmpDir();
    const assets = await makeLookAssets(flatLayout, look, dir, { fps: 30, duration: 1 });
    expect([assets.mask, assets.motion]).toEqual([null, null]);
    expect(existsSync(join(dir, "backdrop.mp4"))).toBe(false);
  });
});

describe("rendering with shader backdrops (spec: backdrops §8 integration)", () => {
  test("a still shader backdrop round-trips through plan.json and has the expected colours at the scene corners", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const p = await plan(master, { look: redBlue(false), output: { width: 640, formats: ["mp4"], poster: null } });
    writeJsonAtomic(join(dir, "plan.json"), p);
    const again = readPlan(join(dir, "plan.json"));
    expect(again.look.backdrop).toEqual(redBlue(false).backdrop);
    const [video] = await render(again, { out: join(dir, "out") });
    const left = await pixelAt(video as string, 0, 640, 360, 3, 180);
    const right = await pixelAt(video as string, 0, 640, 360, 636, 180);
    expect(left[0] as number).toBeGreaterThan(200);
    expect(left[2] as number).toBeLessThan(80);
    expect(right[2] as number).toBeGreaterThan(200);
    expect(right[0] as number).toBeLessThan(80);
  }, 60_000);

  test("a backdrop preset by name renders, and an animated one moves in the render and the debug video", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const named = await plan(master, { look: "ultraviolet", output: { width: 640, formats: ["mp4"], poster: null } });
    expect(named.look.preset).toBe("ultraviolet");
    const p = await plan(master, { look: redBlue(true), output: { width: 640, formats: ["mp4"], poster: null } });
    const [video] = await render(p, { out: join(dir, "out") });
    const a = await pixelAt(video as string, 0, 640, 360, 3, 3);
    const b = await pixelAt(video as string, 15, 640, 360, 3, 3);
    expect(
      Math.abs((a[0] as number) - (b[0] as number)) + Math.abs((a[2] as number) - (b[2] as number)),
    ).toBeGreaterThan(8);
    const { debug } = await preview(p, { out: join(dir, "plan") });
    const d0 = await pixelAt(debug, 0, 960, 540, 4, 4);
    const d15 = await pixelAt(debug, 15, 960, 540, 4, 4);
    expect(
      Math.abs((d0[0] as number) - (d15[0] as number)) + Math.abs((d0[2] as number) - (d15[2] as number)),
    ).toBeGreaterThan(8);
  }, 120_000);

  test("motion with a 2-frame master renders (Review Focus 3)", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 2 / 30, boxes: [] });
    const p = await plan(master, { look: redBlue(true), output: { width: 640, formats: ["mp4"], poster: null } });
    const files = await render(p, { out: join(dir, "out") });
    expect(existsSync(files[0] as string)).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test test/shader-scene.test.ts`
Expected: FAIL (`motion` is not part of `LookAssets`; the scene graph has no `-stream_loop`; a shader backdrop draws black).

- [ ] **Step 3: Draw every backdrop type and make the motion asset**

Replace `src/render/assets.ts` with:

```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Canvas, createCanvas, loadImage } from "@napi-rs/canvas";
import { gradientLine } from "../backdrops/gradient.js";
import { CameraworkError } from "../errors.js";
import { runFfmpeg } from "../ffmpeg.js";
import { lookScale, type SceneLayout, WARP_BORDER } from "../geometry.js";
import type { Backdrop, Look } from "../schema.js";
import { type BackdropMotion, renderBackdropVideo, shaderCanvas } from "./backdrop.js";
import { perspectiveExpr } from "./scene.js";

export interface LookAssets {
  /** A PNG looped as a still, or (when `motion` is set) the animated backdrop's intermediate video, looped. */
  backdrop: string;
  motion: BackdropMotion | null;
  mask: string | null;
  shadow: string | null;
  shadowX: number;
  shadowY: number;
}

/** For an animated backdrop: the output fps and the master's duration (one loop). Leave it out for a still. */
export interface LookTiming {
  fps: number;
  duration: number;
}

const png = (path: string, canvas: Canvas) => writeFileSync(path, canvas.toBuffer("image/png"));

/** Any backdrop as a w×h canvas; a shader backdrop is drawn at loop time 0. */
export async function backdropCanvas(bd: Backdrop, w: number, h: number): Promise<Canvas> {
  if (bd.type === "shader") return shaderCanvas(bd, w, h);
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  if (bd.type === "gradient") {
    const g = ctx.createLinearGradient(...gradientLine(w, h, bd.angle));
    for (const s of bd.stops) g.addColorStop(s.at, s.color);
    ctx.fillStyle = g;
  } else if (bd.type === "solid") {
    ctx.fillStyle = bd.color;
  } else {
    ctx.fillStyle = "#000000";
  }
  ctx.fillRect(0, 0, w, h);
  if (bd.type === "image") {
    let img: Awaited<ReturnType<typeof loadImage>>;
    try {
      img = await loadImage(bd.path);
    } catch {
      throw new CameraworkError(`cannot read the backdrop image ${bd.path}`);
    }
    const s = Math.max(w / img.width, h / img.height); // cover
    ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
  }
  return c;
}

/**
 * Draws the backdrop, the (warped) rounded mask and the shadow once, before rendering (ruling R7). With `timing`, a
 * shader backdrop with motion becomes an intermediate video of one loop; otherwise the backdrop is a PNG. Nothing is
 * drawn for the backdrop when the window covers the whole scene.
 */
export async function makeLookAssets(
  layout: SceneLayout,
  look: Look,
  workDir: string,
  timing?: LookTiming,
): Promise<LookAssets> {
  const k = lookScale(layout.winW);
  const radius = look.radius * k;
  const warp = perspectiveExpr(layout);
  const windowIsScene = layout.sceneW === layout.winW && layout.sceneH === layout.winH;
  // The mask also hides the WARP_BORDER around the window, so it is skipped only when the window is the scene.
  const hidden = radius === 0 && !warp && look.shadow.opacity === 0 && windowIsScene;
  const bd = look.backdrop;
  let backdrop = join(workDir, "backdrop.png");
  let motion: BackdropMotion | null = null;
  if (hidden) return { backdrop, motion, mask: null, shadow: null, shadowX: 0, shadowY: 0 };
  if (bd.type === "shader" && bd.motion.enabled && timing) {
    backdrop = join(workDir, "backdrop.mp4");
    motion = await renderBackdropVideo(bd, layout.sceneW, layout.sceneH, timing.fps, timing.duration, backdrop);
  } else {
    png(backdrop, await backdropCanvas(bd, layout.sceneW, layout.sceneH));
  }

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

  if (look.shadow.opacity === 0) return { backdrop, motion, mask, shadow: null, shadowX: 0, shadowY: 0 };
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
    motion,
    mask,
    shadow,
    shadowX: layout.winX - B - S,
    shadowY: Math.round(layout.winY - B - S + look.shadow.offsetY * k),
  };
}
```

- [ ] **Step 4: Loop the intermediate video in the scene graph**

Replace `src/render/scene.ts` with:

```ts
import { type SceneLayout, WARP_BORDER } from "../geometry.js";
import type { LookAssets } from "./assets.js";
import { motionFilter } from "./backdrop.js";

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
 * With no mask (only when the window is the whole scene) the master passes straight through. A still backdrop is a
 * looped image; an animated one is its intermediate video, looped (`-stream_loop -1`), upscaled and grained.
 */
export function sceneArgs(masterPath: string, layout: SceneLayout, assets: LookAssets, fps: number): string[] {
  if (!assets.mask) return ["-i", masterPath, "-an", "-vf", `fps=${fps},format=rgba`, "-pix_fmt", "rgba"];
  const B = WARP_BORDER;
  const perspective = perspectiveExpr(layout);
  const still = (path: string) => ["-loop", "1", "-framerate", String(fps), "-i", path];
  const backdrop = assets.motion ? ["-stream_loop", "-1", "-i", assets.backdrop] : still(assets.backdrop);
  const inputs = ["-i", masterPath, ...backdrop, ...still(assets.mask)];
  const graph = [
    `[0:v]fps=${fps},format=rgb24,pad=iw+${2 * B}:ih+${2 * B}:${B}:${B}:black${perspective ? `,${perspective}` : ""},format=rgba[v]`,
    "[2:v]format=gray[m]",
    "[v][m]alphamerge=shortest=1[w]",
    assets.motion
      ? `[1:v]fps=${fps},${motionFilter(layout.sceneW, layout.sceneH, assets.motion)},format=rgba[bg]`
      : "[1:v]format=rgba[bg]",
  ];
  let base = "bg";
  if (assets.shadow) {
    inputs.push(...still(assets.shadow));
    graph.push(`[bg][3:v]overlay=${assets.shadowX}:${assets.shadowY}[bs]`);
    base = "bs";
  }
  graph.push(`[${base}][w]overlay=${layout.winX - B}:${layout.winY - B}:shortest=1,format=rgba[out]`);
  return [...inputs, "-an", "-filter_complex", graph.join(";"), "-map", "[out]", "-pix_fmt", "rgba"];
}
```

- [ ] **Step 5: Pass the timing from render and preview**

In `src/render/index.ts` (line 73) and in `src/preview.ts` (line 57) replace:

```ts
    const assets = await makeLookAssets(layout, plan.look, work);
```

with:

```ts
    const assets = await makeLookAssets(layout, plan.look, work, {
      fps: plan.output.fps,
      duration: plan.master.duration,
    });
```

- [ ] **Step 6: Run the new tests and the whole suite**

Run: `bun test test/shader-scene.test.ts && bun run test && bunx biome check . && bunx tsc --noEmit`
Expected: PASS (7 new tests; `scene.test.ts`, `render.test.ts` and `preview.test.ts` unchanged and green).

- [ ] **Step 7: Commit**

```bash
git add src/render/assets.ts src/render/scene.ts src/render/index.ts src/preview.ts test/shader-scene.test.ts
git commit -m "feat(render): shader backdrops in render and preview, animated ones as a looped intermediate video"
```

---

### Task 8: The look editor's server

**Files:**
- Create: `src/placeholder.ts`, `src/editor/server.ts`
- Test: `test/editor-server.test.ts`

**Interfaces:**
- Consumes: Task 5 (`resolveLook`, `LOOKS`, `EDITOR_ASSETS`, `LookInfo`, `SaveReply`), `probe`, `readFrames`, `requireFfmpeg` (`src/ffmpeg.ts`), `writeJsonAtomic` (`src/plan/index.ts`, import only), `makeBoxVideo`, `tmpDir` (`test/helpers.ts`).
- Produces (exact):
  - `src/placeholder.ts`: `PLACEHOLDER = { width: 1920, height: 1080, duration: 10 }`; `placeholderWindow(): Buffer` (a 1920×1080 PNG window mock).
  - `src/editor/server.ts`: `interface EditorOptions { out: string; look: Look; master?: string; port?: number; idleMs?: number; firstContactMs?: number; assetsDir?: string }`; `interface EditorSession { url: string; host: string; port: number; done: Promise<string | null>; close(): Promise<void> }`; `startEditor(opts: EditorOptions): Promise<EditorSession>`; `openUrl(url: string, command?: string): Promise<boolean>`.
  - The endpoints of `src/editor/protocol.ts`. The page assets are looked up in `assetsDir`, else next to the compiled module (`dist/editor/` holds both `server.js` and the page), else `../../dist/editor` from the source file (a checkout run with Bun). A missing page is a readable 500 ("not built"), not a crash.

These tests do not need the esbuild bundle: they serve a fake page from a temp directory. Task 10 checks the server with the real bundle.

- [ ] **Step 1: Write the failing tests**

`test/editor-server.test.ts` (127.0.0.1 binding, every endpoint, invalid and valid saves, the idle timeout with a short knob, and Review Focus 4 and 5):

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import type { LookInfo } from "../src/editor/protocol.js";
import { type EditorOptions, type EditorSession, openUrl, startEditor } from "../src/editor/server.js";
import { CameraworkError } from "../src/errors.js";
import { LOOKS, resolveLook } from "../src/looks.js";
import { PLACEHOLDER } from "../src/placeholder.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

const sessions: EditorSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

/** A fake built page, so these tests do not depend on the esbuild bundle. */
function fakeAssets(): string {
  const dir = join(tmpDir(), "editor");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>camerawork look editor</title>");
  writeFileSync(join(dir, "editor.js"), "console.log('editor')");
  writeFileSync(join(dir, "editor.css"), "body{}");
  return dir;
}

async function start(more: Partial<EditorOptions> = {}): Promise<{ session: EditorSession; out: string }> {
  const out = join(tmpDir(), "my look.json");
  const session = await startEditor({ out, look: resolveLook("hero"), assetsDir: fakeAssets(), ...more });
  sessions.push(session);
  return { session, out };
}

const post = (session: EditorSession, path: string, body: string, type = "application/json") =>
  fetch(new URL(path, session.url), { method: "POST", body, headers: { "content-type": type } });

/** A request with a chosen Host header (fetch does not allow setting it). */
function withHost(port: number, host: string): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/look", headers: { host } }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on("error", fail);
    req.end();
  });
}

describe("editor server", () => {
  test("binds 127.0.0.1 on a free port and serves the page files", async () => {
    const { session } = await start();
    expect(session.host).toBe("127.0.0.1");
    expect(session.url).toBe(`http://127.0.0.1:${session.port}/`);
    const page = await fetch(session.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("camerawork look editor");
    expect((await fetch(new URL("/editor.js", session.url))).headers.get("content-type")).toContain("javascript");
    expect((await fetch(new URL("/nope", session.url))).status).toBe(404);
  });

  test("an unbuilt page is a readable 500, not a crash", async () => {
    const { session } = await start({ assetsDir: tmpDir() });
    const page = await fetch(session.url);
    expect(page.status).toBe(500);
    expect(await page.text()).toContain("not built");
  });

  test("refuses other Host headers (DNS rebinding) and non-JSON saves", async () => {
    const { session } = await start();
    expect(await withHost(session.port, "evil.example")).toBe(403);
    expect(await withHost(session.port, `localhost:${session.port}`)).toBe(200);
    expect((await post(session, "/save", JSON.stringify(LOOKS.hero), "text/plain")).status).toBe(415);
  });

  test("without --master: the look, a placeholder window and its size (Review Focus 4)", async () => {
    const { session, out } = await start();
    const info = (await (await fetch(new URL("/look", session.url))).json()) as LookInfo;
    expect(info.hasMaster).toBe(false);
    expect(info.window).toEqual(PLACEHOLDER);
    expect(info.look).toEqual(LOOKS.hero);
    expect(info.out).toBe(out);
    const frame = await fetch(new URL("/frame?t=3", session.url));
    expect(frame.headers.get("content-type")).toBe("image/png");
    const img = await loadImage(Buffer.from(await frame.arrayBuffer()));
    expect([img.width, img.height]).toEqual([1920, 1080]);
  });

  test("with --master: its size and duration, and frames as JPEG", async () => {
    const master = join(tmpDir(), "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 2, boxes: [] });
    const { session } = await start({ master });
    const info = (await (await fetch(new URL("/look", session.url))).json()) as LookInfo;
    expect(info.hasMaster).toBe(true);
    expect([info.window.width, info.window.height]).toEqual([640, 360]);
    expect(info.window.duration).toBeCloseTo(2, 1);
    const frame = await fetch(new URL("/frame?t=0.5", session.url));
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    const img = await loadImage(Buffer.from(await frame.arrayBuffer()));
    expect([img.width, img.height]).toEqual([640, 360]);
    expect((await fetch(new URL("/frame?t=99", session.url))).status).toBe(200); // clamped to the last frame
  }, 30_000);

  test("an invalid look is a 400 naming the field; nothing is written and the session goes on", async () => {
    const { session, out } = await start();
    const bad = { ...LOOKS.hero, backdrop: { type: "shader", style: "silk", grain: 0.9 } };
    const reply = await post(session, "/save", JSON.stringify(bad));
    expect(reply.status).toBe(400);
    expect(((await reply.json()) as { error: string }).error).toContain("backdrop.grain");
    expect((await post(session, "/save", "{not json")).status).toBe(400);
    expect(existsSync(out)).toBe(false);
    expect((await fetch(new URL("/look", session.url))).status).toBe(200);
  });

  test("a valid save writes the file atomically (defaults filled in) and ends the session with its path", async () => {
    const { session, out } = await start();
    const look = { ...LOOKS.hero, backdrop: { type: "shader", style: "aurora", seed: 3 } };
    const reply = await post(session, "/save", JSON.stringify(look));
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ saved: out });
    expect(await session.done).toBe(out);
    const saved = JSON.parse(readFileSync(out, "utf8"));
    expect(saved.backdrop).toMatchObject({ type: "shader", style: "aurora", seed: 3, grain: 0.04 });
    expect(saved.backdrop.colors).toHaveLength(4);
    expect(existsSync(`${out}.tmp-${process.pid}`)).toBe(false);
    await expect(fetch(session.url)).rejects.toThrow();
  });

  test("ends without writing after the idle timeout; heartbeats keep it alive", async () => {
    const { session, out } = await start({ idleMs: 300, firstContactMs: 300 });
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 100));
      expect((await post(session, "/heartbeat", "")).status).toBe(204);
    }
    const t0 = performance.now();
    expect(await session.done).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(existsSync(out)).toBe(false);
  });

  test("a closed tab (/bye) ends the session within the short grace", async () => {
    const { session } = await start({ idleMs: 60_000 });
    await post(session, "/heartbeat", "");
    await post(session, "/bye", "");
    const t0 = performance.now();
    expect(await session.done).toBeNull();
    expect(performance.now() - t0).toBeLessThan(6000);
  }, 10_000);

  test("a port in use is a CameraworkError naming it (Review Focus 5)", async () => {
    const blocker = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(start({ port })).rejects.toThrow(CameraworkError);
      await expect(start({ port })).rejects.toThrow(`port ${port} is already in use`);
    } finally {
      blocker.close();
    }
  });

  test("openUrl reports a missing or failing browser opener instead of throwing (Review Focus 5)", async () => {
    expect(await openUrl("http://127.0.0.1:9/", "camerawork-no-such-opener")).toBe(false);
    expect(await openUrl("http://127.0.0.1:9/", "false")).toBe(false);
    expect(await openUrl("http://127.0.0.1:9/", "true")).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test test/editor-server.test.ts`
Expected: FAIL with `Cannot find module '../src/editor/server.js'`.

- [ ] **Step 3: Write the placeholder window**

`src/placeholder.ts`:

```ts
import { createCanvas } from "@napi-rs/canvas";

/** The neutral window used without a master: its size, and a duration for the editor's time slider. */
export const PLACEHOLDER = { width: 1920, height: 1080, duration: 10 };

/** A neutral app-window mock (title bar, sidebar, lines of content, a button) as a 1920×1080 PNG. */
export function placeholderWindow(): Buffer {
  const { width, height } = PLACEHOLDER;
  const c = createCanvas(width, height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#f5f5f7";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#e4e4e7";
  ctx.fillRect(0, 0, width, 56);
  for (const [i, color] of ["#ff5f57", "#febc2e", "#28c840"].entries()) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(32 + i * 28, 28, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#ececef";
  ctx.fillRect(0, 56, 360, height - 56);
  ctx.fillStyle = "#d4d4d8";
  for (let i = 0; i < 8; i++) ctx.fillRect(32, 100 + i * 56, 220 - (i % 3) * 40, 20);
  for (let i = 0; i < 10; i++) ctx.fillRect(420, 120 + i * 76, 1300 - (i % 4) * 180, 24);
  ctx.fillStyle = "#6366f1";
  ctx.fillRect(420, 900, 220, 64);
  return c.toBuffer("image/png");
}
```

- [ ] **Step 4: Write the server**

`src/editor/server.ts` (frames are clamped to 1.5 frame-durations before the end: `-ss` exactly at the last frame's timestamp returns nothing):

```ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { CameraworkError } from "../errors.js";
import { probe, readFrames, requireFfmpeg } from "../ffmpeg.js";
import { resolveLook } from "../looks.js";
import { PLACEHOLDER, placeholderWindow } from "../placeholder.js";
import { writeJsonAtomic } from "../plan/index.js";
import type { Look, Probe } from "../schema.js";
import { EDITOR_ASSETS, type LookInfo, type SaveReply } from "./protocol.js";

export interface EditorOptions {
  /** The look file Save writes (made absolute). */
  out: string;
  /** The starting look, already resolved. */
  look: Look;
  /** A master video: the preview shows its frames. Without it, a neutral placeholder window. */
  master?: string;
  /** 0 or left out: a free port. */
  port?: number;
  /** End an unsaved session this long after the last heartbeat (default 120 s). */
  idleMs?: number;
  /** End it this long after start if the page never connects (default 15 min). */
  firstContactMs?: number;
  /** Where index.html, editor.js and editor.css are (default: next to this module, else ../../dist/editor). */
  assetsDir?: string;
}

export interface EditorSession {
  /** http://127.0.0.1:<port>/ */
  url: string;
  host: string;
  port: number;
  /** Resolves with the saved file's path, or null when the session ended without a save. */
  done: Promise<string | null>;
  /** Ends the session now (as unsaved, unless already saved). */
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** The built page: next to the compiled server (dist/editor/), or dist/editor/ of a source checkout. */
function findAssets(dir?: string): string {
  if (dir) return dir;
  const here = dirname(fileURLToPath(import.meta.url));
  return existsSync(join(here, "index.html")) ? here : resolve(here, "../../dist/editor");
}

/** Opens a URL in the default browser (macOS `open`, Linux `xdg-open`). Resolves false when that fails. */
export function openUrl(url: string, command = process.platform === "darwin" ? "open" : "xdg-open"): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    const timer = setTimeout(() => {
      child.unref();
      done(true);
    }, 2000);
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(data));

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((ok, fail) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > limit) {
        fail(new CameraworkError("the look is too large"));
        req.destroy();
      }
    });
    req.on("end", () => ok(body));
    req.on("error", fail);
  });
}

/** One frame of the master at t seconds, at most 1920 px wide, as a JPEG. */
async function masterFrame(master: Probe, t: number): Promise<Buffer> {
  const w = Math.min(1920, master.width);
  const h = Math.max(2, Math.round((master.height * w) / master.width / 2) * 2);
  const at = Math.min(Math.max(0, t), Math.max(0, master.duration - 1.5 / master.fps)); // the last frame, not after it
  let frame: Buffer | null = null;
  await readFrames(
    ["-ss", at.toFixed(3), "-i", master.path, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-pix_fmt", "rgba"],
    w * h * 4,
    (f) => {
      frame = Buffer.from(f);
    },
  );
  if (!frame) throw new CameraworkError(`no frame at ${at.toFixed(2)} s`);
  const c = createCanvas(w, h);
  const pixels = frame as Buffer;
  c.getContext("2d").putImageData(
    new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length), w, h),
    0,
    0,
  );
  return c.toBuffer("image/jpeg", 88);
}

/**
 * The look editor's server (spec: backdrops §6): bound to 127.0.0.1 only. It serves the page, the starting look,
 * frames of the master, and saves the look (validated with the look schema, written atomically). The session ends
 * after a save, or after `idleMs` without a heartbeat from the page.
 */
export async function startEditor(opts: EditorOptions): Promise<EditorSession> {
  const out = resolve(opts.out);
  let master: Probe | null = null;
  if (opts.master) {
    requireFfmpeg();
    master = probe(opts.master);
  }
  const info: LookInfo = {
    look: opts.look,
    window: master ? { width: master.width, height: master.height, duration: master.duration } : PLACEHOLDER,
    hasMaster: master !== null,
    out,
  };
  const assets = findAssets(opts.assetsDir);
  const idleMs = opts.idleMs ?? 120_000;
  const frames = new Map<string, Buffer>();
  let placeholder: Buffer | null = null;

  let finish: (saved: string | null) => void = () => {};
  const done = new Promise<string | null>((ok) => {
    finish = ok;
  });
  let timer: NodeJS.Timeout | undefined;
  let ended = false;
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof CameraworkError ? error.message : String(error);
      if (!res.headersSent) json(res, 500, { error: message });
    });
  });
  const end = (saved: string | null) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    finish(saved);
  };
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => end(null), ms);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { port } = server.address() as AddressInfo;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`)
      return send(res, 403, "text/plain", "forbidden");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const route = `${req.method} ${url.pathname}`;
    if (route === "POST /heartbeat") {
      arm(idleMs);
      return send(res, 204, "text/plain", "");
    }
    if (route === "POST /bye") {
      arm(Math.min(idleMs, 5000)); // the tab closed; a reload heartbeats again within this grace
      return send(res, 204, "text/plain", "");
    }
    if (route === "GET /look") return json(res, 200, info);
    if (route === "GET /frame") {
      if (!master) {
        placeholder ??= placeholderWindow();
        return send(res, 200, "image/png", placeholder);
      }
      const key = (Number(url.searchParams.get("t")) || 0).toFixed(2);
      let jpeg = frames.get(key);
      if (!jpeg) {
        jpeg = await masterFrame(master, Number(key));
        if (frames.size >= 64) frames.delete(frames.keys().next().value as string);
        frames.set(key, jpeg);
      }
      return send(res, 200, "image/jpeg", jpeg);
    }
    if (route === "POST /save") {
      if (!String(req.headers["content-type"]).startsWith("application/json"))
        return json(res, 415, { error: "send the look as application/json" } satisfies SaveReply);
      let look: Look;
      try {
        look = resolveLook(JSON.parse(await readBody(req, 1_000_000)) as Look);
      } catch (error) {
        const message = error instanceof CameraworkError ? error.message : "the look is not valid JSON";
        return json(res, 400, { error: message } satisfies SaveReply);
      }
      try {
        writeJsonAtomic(out, look);
      } catch (error) {
        return json(res, 500, { error: `cannot write ${out}: ${(error as Error).message}` } satisfies SaveReply);
      }
      res.on("finish", () => end(out));
      return json(res, 200, { saved: out } satisfies SaveReply);
    }
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (req.method === "GET" && (EDITOR_ASSETS as readonly string[]).includes(name)) {
      const path = join(assets, name);
      if (!existsSync(path))
        return send(res, 500, "text/plain", `the editor page is not built (${path} is missing): run the build first`);
      return send(res, 200, TYPES[extname(name)] ?? "application/octet-stream", readFileSync(path));
    }
    return send(res, 404, "text/plain", "not found");
  }

  await new Promise<void>((ok, fail) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE")
        fail(new CameraworkError(`port ${opts.port} is already in use: pick another --port, or leave it out`));
      else if (error.code === "EACCES")
        fail(new CameraworkError(`port ${opts.port} needs special permissions: pick a port above 1024`));
      else fail(error);
    });
    server.listen(opts.port ?? 0, "127.0.0.1", () => ok());
  });
  arm(opts.firstContactMs ?? 900_000);
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    host: address,
    port,
    done,
    close: async () => {
      end(null);
      await done;
    },
  };
}
```

- [ ] **Step 5: Run the tests, lint and typecheck**

Run: `bun test test/editor-server.test.ts && bunx biome check . && bunx tsc --noEmit`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add src/placeholder.ts src/editor/server.ts test/editor-server.test.ts
git commit -m "feat(editor): local look editor server on 127.0.0.1 (page, look, frames, validated atomic save, idle exit)"
```

---

### Task 9: The look editor's page and its esbuild bundle

**Files:**
- Create: `editor/index.html`, `editor/editor.css`, `editor/state.ts`, `editor/view.ts`, `editor/controls.ts`, `editor/main.ts`, `scripts/build-editor.mjs`
- Modify: `package.json` (scripts `build`, `prepare`; devDependency `esbuild`), `bun.lock` (via `bun add`), `tsconfig.json` (`include`), `biome.json` (`files.includes`), `.github/workflows/ci.yml` (last step)
- Test: `test/editor-page.test.ts`

**Interfaces:**
- Consumes: Task 1 (`fieldSize`, `gradientLine`, `applyGrain`), Task 5 (`STYLES`, `STYLE_NAMES`, `StyleName`, `shaderColors`, `shaderField`, `BACKDROPS`, `LookInfo`, `SaveReply`, `HEARTBEAT_MS`, `EDITOR_ASSETS`), `sceneLayout`, `lookScale`, `applyH`, `SceneLayout` (`src/geometry.ts`, unchanged).
- Produces (exact):
  - `editor/state.ts` (pure, tested under Bun): `SHADER_DEFAULTS`; `interface Range { path: string; label: string; min: number; max: number; step: number; group: "backdrop" | "window" }`; `RANGES: Range[]`; `shaderFor(style: StyleName, from: Backdrop): ShaderBackdrop`; `getPath(look: Look, path: string): unknown`; `setPath(look: Look, path: string, value: unknown): Look`; `addColor(colors: string[]): string[]`; `removeColor(colors: string[], i: number): string[]`; `lookJson(look: Look): string`; `interface WindowBox { left; top; width; height; radius: number; transform: string; shadow: string }`; `windowBox(layout: SceneLayout, look: Look, s: number): WindowBox`.
  - `editor/view.ts`: `interface PaintOptions { t: number; frame: number; maxField: number }`; `paintBackdrop(canvas: HTMLCanvasElement, bd: Backdrop, opts: PaintOptions): void`.
  - `editor/controls.ts`: `interface Controls { sync(look: Look): void }`; `buildControls(form: HTMLFormElement, current: () => Look, change: (look: Look, draft: boolean) => void): Controls`.
  - `scripts/build-editor.mjs [outDir]` writes `index.html`, `editor.js`, `editor.css` (the names in `EDITOR_ASSETS`) to `outDir` (default `dist/editor/`). `bun run build` and `prepare` run `tsc` then this script.

Page layout (spec §6): top bar (output path, status, Copy JSON, Reset, Save); left: the composed preview (backdrop canvas, the window as an `<img>` of `/frame?t=…` with radius, box-shadow and the tilt as a `matrix3d` of the layout's homography), a Play toggle and the frame-time slider; right: a collapsible grid of live preset thumbnails, then Backdrop controls (style, 2–5 colours with add/remove, angle, scale, distortion, grain, vignette, seed with Shuffle, motion and its speed) and Window controls (padding, corner radius, shadow blur/offset/opacity, tilt X/Y). While a slider is dragged the backdrop is painted from a 320-px field, and from up to 1280 px 200 ms after the last change.

esbuild must stay a **devDependency**: npm installs devDependencies before running `prepare` for git installs (`npm pack git+https://…`, which the installer uses), so `prepare` can bundle; registry installs ship the built `dist/`.

- [ ] **Step 1: Add esbuild and the build wiring**

Run: `bun add -d --exact esbuild@0.28.2`
Expected: `package.json` gains `"esbuild": "0.28.2"` under `devDependencies` and `bun.lock` changes.

In `package.json` replace:

```json
    "build": "tsc -p tsconfig.build.json",
    "prepare": "tsc -p tsconfig.build.json",
```

with:

```json
    "build": "tsc -p tsconfig.build.json && node scripts/build-editor.mjs",
    "prepare": "tsc -p tsconfig.build.json && node scripts/build-editor.mjs",
```

In `tsconfig.json` replace `"include": ["src", "test"]` with `"include": ["src", "test", "editor", "scripts"]` (the page is type-checked with the DOM types of the default lib; `tsconfig.build.json` still compiles only `src/`).

In `biome.json` replace `"files": { "includes": ["src/**", "test/**", "*.json"] },` with:

```json
  "files": { "includes": ["src/**", "test/**", "editor/**/*.ts", "scripts/**", "*.json"] },
```

In `.github/workflows/ci.yml` replace the last step `- run: bun run build && node dist/cli.js --version` with:

```yaml
      - run: bun run build && node dist/cli.js --version && test -f dist/editor/index.html && test -f dist/editor/editor.js
```

- [ ] **Step 2: Write the failing tests**

`test/editor-page.test.ts` (pure page logic, the slider ranges against the schema, the exact tilt matrix, and the bundle):

```ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  addColor,
  getPath,
  RANGES,
  removeColor,
  SHADER_DEFAULTS,
  setPath,
  shaderFor,
  windowBox,
} from "../editor/state.js";
import { STYLES } from "../src/backdrops/index.js";
import { EDITOR_ASSETS } from "../src/editor/protocol.js";
import { applyH, sceneLayout } from "../src/geometry.js";
import { LOOKS, resolveLook } from "../src/looks.js";
import { LookSchema } from "../src/schema.js";
import { tmpDir } from "./helpers.js";

const root = join(import.meta.dir, "..");

describe("editor state", () => {
  test("picking a style turns any backdrop into a shader with the spec's defaults", () => {
    expect(shaderFor("waves", LOOKS.hero.backdrop)).toEqual({
      type: "shader",
      style: "waves",
      colors: STYLES.waves.colors,
      ...SHADER_DEFAULTS,
    });
    const silk = resolveLook("ultraviolet").backdrop;
    const mesh = shaderFor("mesh", silk);
    expect(mesh).toMatchObject({ style: "mesh", angle: 62, seed: 7, colors: ["#12002e", "#7b2bff", "#ff2bd6"] });
  });

  test("getPath and setPath edit one setting and leave the original alone", () => {
    const look = resolveLook("ultraviolet");
    const next = setPath(look, "backdrop.motion.speed", 1.5);
    expect(getPath(next, "backdrop.motion.speed")).toBe(1.5);
    expect(getPath(look, "backdrop.motion.speed")).toBe(0.3);
    expect(getPath(look, "backdrop.nothing.here")).toBeUndefined();
  });

  test("colours stay between 2 and 5", () => {
    expect(addColor(["#000000", "#111111"])).toEqual(["#000000", "#111111", "#111111"]);
    expect(addColor(["#0", "#1", "#2", "#3", "#4"])).toHaveLength(5);
    expect(removeColor(["#000000", "#111111", "#222222"], 1)).toEqual(["#000000", "#222222"]);
    expect(removeColor(["#000000", "#111111"], 0)).toHaveLength(2);
  });

  test("every slider's range is valid in the look schema", () => {
    const base = resolveLook("ultraviolet");
    for (const r of RANGES)
      for (const value of [r.min, r.max]) expect(LookSchema.safeParse(setPath(base, r.path, value)).success).toBe(true);
  });

  test("windowBox places the window like the render: the same layout, the tilt as an exact matrix3d", () => {
    const flat = resolveLook("hero");
    const layout = sceneLayout({ width: 1920, height: 1080 }, flat, 16 / 9);
    const box = windowBox(layout, flat, 0.5);
    expect([box.left, box.top, box.width, box.height]).toEqual([layout.winX * 0.5, layout.winY * 0.5, 960, 540]);
    expect(box.radius).toBe(9);
    expect(box.transform).toBe("matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)");
    expect(box.shadow).toBe("0 12px 30px rgba(0,0,0,0.55)");

    const tilted = { ...flat, tilt: { rotateX: 6, rotateY: -12, perspective: 2400 } };
    const tl = sceneLayout({ width: 1920, height: 1080 }, tilted, 16 / 9);
    const s = 0.5;
    const m = (windowBox(tl, tilted, s).transform.match(/matrix3d\((.*)\)/)?.[1] ?? "").split(",").map(Number);
    // column-major 4×4 → the 2D homography [a b c; d e f; g h i]
    const H = [m[0], m[4], m[12], m[1], m[5], m[13], m[3], m[7], m[15]] as number[];
    const [x, y] = applyH(H, [1920 * s, 1080 * s]);
    const [qx, qy] = tl.quad[3];
    expect(x).toBeCloseTo(qx * s, 3);
    expect(y).toBeCloseTo(qy * s, 3);
  });
});

describe("editor build", () => {
  test("esbuild bundles the page for the browser, with no Node modules and no zod", () => {
    const out = join(tmpDir(), "editor");
    const r = spawnSync("node", [join(root, "scripts/build-editor.mjs"), out], { encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const file of EDITOR_ASSETS) expect(existsSync(join(out, file))).toBe(true);
    const js = readFileSync(join(out, "editor.js"), "utf8");
    expect(js).not.toContain("node:");
    expect(js).not.toContain("ZodError");
    expect(statSync(join(out, "editor.js")).size).toBeLessThan(150_000);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain('src="/editor.js"');
    expect(html).toContain('href="/editor.css"');
  }, 60_000);
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `bun test test/editor-page.test.ts`
Expected: FAIL with `Cannot find module '../editor/state.js'`.

- [ ] **Step 4: Write the pure page logic**

`editor/state.ts`:

```ts
import { STYLES, shaderColors } from "../src/backdrops/index.js";
import type { StyleName } from "../src/backdrops/types.js";
import { lookScale, type SceneLayout } from "../src/geometry.js";
import type { Backdrop, Look, ShaderBackdrop } from "../src/schema.js";

/** The spec's shared defaults (backdrops §2), used when the editor turns another backdrop into a shader. */
export const SHADER_DEFAULTS = {
  angle: 45,
  scale: 1,
  distortion: 0.3,
  seed: 1,
  grain: 0.04,
  vignette: 0,
  motion: { enabled: false, speed: 0.3 },
};

/** A slider: the look setting it edits (a dotted path), its label and its range. */
export interface Range {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  group: "backdrop" | "window";
}

/** Every slider on the page, with the schema's ranges (spec: backdrops §2 and §6). */
export const RANGES: Range[] = [
  { path: "backdrop.angle", label: "Angle", min: 0, max: 360, step: 1, group: "backdrop" },
  { path: "backdrop.scale", label: "Scale", min: 0.2, max: 5, step: 0.05, group: "backdrop" },
  { path: "backdrop.distortion", label: "Distortion", min: 0, max: 1, step: 0.01, group: "backdrop" },
  { path: "backdrop.grain", label: "Grain", min: 0, max: 0.3, step: 0.005, group: "backdrop" },
  { path: "backdrop.vignette", label: "Vignette", min: 0, max: 1, step: 0.01, group: "backdrop" },
  { path: "backdrop.motion.speed", label: "Motion speed", min: 0.05, max: 2, step: 0.05, group: "backdrop" },
  { path: "padding", label: "Padding", min: 0, max: 0.45, step: 0.005, group: "window" },
  { path: "radius", label: "Corner radius", min: 0, max: 80, step: 1, group: "window" },
  { path: "shadow.blur", label: "Shadow blur", min: 0, max: 200, step: 1, group: "window" },
  { path: "shadow.offsetY", label: "Shadow offset", min: -100, max: 100, step: 1, group: "window" },
  { path: "shadow.opacity", label: "Shadow opacity", min: 0, max: 1, step: 0.01, group: "window" },
  { path: "tilt.rotateX", label: "Tilt X", min: -30, max: 30, step: 0.5, group: "window" },
  { path: "tilt.rotateY", label: "Tilt Y", min: -30, max: 30, step: 0.5, group: "window" },
];

/** The backdrop with `style` chosen: a shader keeps its settings and colours; anything else starts from defaults. */
export function shaderFor(style: StyleName, from: Backdrop): ShaderBackdrop {
  if (from.type === "shader") return { ...structuredClone(from), style, colors: [...shaderColors(from)] };
  return { type: "shader", style, colors: [...STYLES[style].colors], ...structuredClone(SHADER_DEFAULTS) };
}

/** A setting by dotted path ("backdrop.motion.speed"); undefined when the look has no such setting. */
export function getPath(look: Look, path: string): unknown {
  let node: unknown = look;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[key];
  return node;
}

/** A copy of the look with one setting changed. */
export function setPath(look: Look, path: string, value: unknown): Look {
  const copy = structuredClone(look) as unknown as Record<string, unknown>;
  const keys = path.split(".");
  let node = copy;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys[keys.length - 1] as string] = value;
  return copy as unknown as Look;
}

/** One more colour (a copy of the last), at most 5. */
export const addColor = (colors: string[]): string[] =>
  colors.length >= 5 ? colors : [...colors, colors[colors.length - 1] as string];

/** Without colour i, at least 2. */
export const removeColor = (colors: string[], i: number): string[] =>
  colors.length <= 2 ? colors : colors.filter((_, j) => j !== i);

/** The look as the page shows it in Copy JSON and sends it to Save. */
export const lookJson = (look: Look): string => `${JSON.stringify(look, null, 2)}\n`;

/** Where and how the window sits in a preview drawn at `s` preview pixels per scene pixel. */
export interface WindowBox {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
  /** CSS transform (with transform-origin 0 0): the layout's tilt homography, exactly as the render warps. */
  transform: string;
  /** CSS box-shadow: blur and offset scaled like the render's (Gaussian sigma = blur / 2). */
  shadow: string;
}

const n = (x: number) => Number(x.toFixed(9));

export function windowBox(layout: SceneLayout, look: Look, s: number): WindowBox {
  const h = layout.h.map((x) => x);
  const k = lookScale(layout.winW) * s;
  // layout.h maps window-local master px to tilted px; in preview px that is S·H·S⁻¹ with S = diag(s, s, 1),
  // written column-major as a CSS matrix3d.
  const m = [h[0], h[3], 0, (h[6] as number) / s, h[1], h[4], 0, (h[7] as number) / s, 0, 0, 1, 0];
  m.push((h[2] as number) * s, (h[5] as number) * s, 0, h[8]);
  return {
    left: layout.winX * s,
    top: layout.winY * s,
    width: layout.winW * s,
    height: layout.winH * s,
    radius: look.radius * k,
    transform: `matrix3d(${m.map((x) => n(x as number)).join(",")})`,
    shadow:
      look.shadow.opacity > 0
        ? `0 ${n(look.shadow.offsetY * k)}px ${n(look.shadow.blur * k)}px rgba(0,0,0,${look.shadow.opacity})`
        : "none",
  };
}
```

- [ ] **Step 5: Write the canvas painter and the controls**

`editor/view.ts`:

```ts
import { fieldSize } from "../src/backdrops/field.js";
import { gradientLine } from "../src/backdrops/gradient.js";
import { shaderField } from "../src/backdrops/index.js";
import { applyGrain } from "../src/backdrops/post.js";
import type { Backdrop } from "../src/schema.js";

const scratch = document.createElement("canvas");

export interface PaintOptions {
  /** Loop time 0–1 (0 when not playing). */
  t: number;
  /** Frame number, for the grain's seed while playing. */
  frame: number;
  /** The field's long side: small while dragging, up to 1280 when settled (spec: backdrops §6). */
  maxField: number;
}

/**
 * Paints a backdrop into a canvas the way the render does: a shader is computed at a reduced field size, upscaled
 * with high-quality smoothing, then grained at the canvas's size. Gradients use the render's gradient line.
 */
export function paintBackdrop(canvas: HTMLCanvasElement, bd: Backdrop, opts: PaintOptions): void {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const { width: w, height: h } = canvas;
  if (bd.type === "shader") {
    const [fw, fh] = fieldSize(w, h, opts.maxField);
    scratch.width = fw;
    scratch.height = fh;
    const px = shaderField(bd, fw, fh, opts.t) as Uint8ClampedArray<ArrayBuffer>;
    (scratch.getContext("2d") as CanvasRenderingContext2D).putImageData(new ImageData(px, fw, fh), 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(scratch, 0, 0, w, h);
    if (bd.grain > 0) {
      const img = ctx.getImageData(0, 0, w, h);
      applyGrain(img.data, w, h, { grain: bd.grain, seed: bd.seed, frame: opts.frame, cell: 1 });
      ctx.putImageData(img, 0, 0);
    }
    return;
  }
  if (bd.type === "gradient") {
    const g = ctx.createLinearGradient(...gradientLine(w, h, bd.angle));
    for (const s of bd.stops) g.addColorStop(s.at, s.color);
    ctx.fillStyle = g;
  } else if (bd.type === "solid") {
    ctx.fillStyle = bd.color;
  } else {
    ctx.fillStyle = bd.type === "image" ? "#2a2a2e" : "#000000";
  }
  ctx.fillRect(0, 0, w, h);
  if (bd.type === "image") {
    ctx.fillStyle = "#a1a1aa";
    ctx.font = `${Math.max(11, Math.round(h / 24))}px system-ui, sans-serif`;
    ctx.fillText("image backdrop (shown in the render)", 12, h - 12);
  }
}
```

`editor/controls.ts`:

```ts
import { STYLE_NAMES, type StyleName } from "../src/backdrops/index.js";
import type { Look } from "../src/schema.js";
import { addColor, getPath, RANGES, type Range, removeColor, setPath, shaderFor } from "./state.js";

export interface Controls {
  /** Shows a look's values (after Reset or a preset). */
  sync(look: Look): void;
}

type Change = (look: Look, draft: boolean) => void;

/** A new element with some properties set (textContent, type, value, …). */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

/**
 * Builds the right-hand controls (spec: backdrops §6) into `form`. `current` reads the page's look; `change` gets
 * each edit, with draft = true while a slider is being dragged.
 */
export function buildControls(form: HTMLFormElement, current: () => Look, change: Change): Controls {
  const ranges = new Map<string, [HTMLInputElement, HTMLOutputElement]>();
  const backdropSet = el("fieldset");
  backdropSet.append(el("legend", { textContent: "Backdrop" }));
  const style = el("select", { id: "style" });
  for (const name of STYLE_NAMES) style.append(el("option", { value: name, textContent: name }));
  style.addEventListener("change", () => {
    const look = current();
    change({ ...look, backdrop: shaderFor(style.value as StyleName, look.backdrop) }, false);
    sync(current());
  });
  const colors = el("div", { className: "colors" });
  const seed = el("input", { type: "number", step: "1", id: "seed" });
  seed.addEventListener("change", () =>
    change(setPath(current(), "backdrop.seed", Math.trunc(Number(seed.value))), false),
  );
  const shuffle = el("button", { type: "button", textContent: "Shuffle" });
  shuffle.addEventListener("click", () => {
    // UI randomness only: the backdrop itself is fully determined by the seed it gets.
    const next = Math.floor(Math.random() * 100_000);
    seed.value = String(next);
    change(setPath(current(), "backdrop.seed", next), false);
  });
  const motion = el("input", { type: "checkbox", id: "motion" });
  motion.addEventListener("change", () => change(setPath(current(), "backdrop.motion.enabled", motion.checked), false));

  const row = (label: string, ...children: HTMLElement[]) => {
    const r = el("label", { className: "row" });
    r.append(el("span", { textContent: label }), ...children);
    return r;
  };
  const slider = (r: Range) => {
    const input = el("input", { type: "range", min: String(r.min), max: String(r.max), step: String(r.step) });
    const out = el("output");
    input.addEventListener("input", () => {
      out.value = input.value;
      change(setPath(current(), r.path, Number(input.value)), true);
    });
    input.addEventListener("change", () => change(setPath(current(), r.path, Number(input.value)), false));
    ranges.set(r.path, [input, out]);
    return row(r.label, input, out);
  };
  backdropSet.append(row("Style", style), colors);
  for (const r of RANGES.filter((x) => x.group === "backdrop" && x.path !== "backdrop.motion.speed"))
    backdropSet.append(slider(r));
  backdropSet.append(row("Seed", seed, shuffle), row("Motion", motion));
  backdropSet.append(slider(RANGES.find((x) => x.path === "backdrop.motion.speed") as Range));
  const windowSet = el("fieldset");
  windowSet.append(el("legend", { textContent: "Window" }));
  for (const r of RANGES.filter((x) => x.group === "window")) windowSet.append(slider(r));
  form.replaceChildren(backdropSet, windowSet);

  function drawColors(list: string[]) {
    colors.replaceChildren();
    list.forEach((value, i) => {
      const pick = el("input", { type: "color", value, title: `Colour ${i + 1}` });
      pick.addEventListener("input", () => {
        const next = [...list];
        next[i] = pick.value;
        change(setPath(current(), "backdrop.colors", next), true);
      });
      pick.addEventListener("change", () => change(current(), false));
      const remove = el("button", { type: "button", textContent: "×", title: "Remove", disabled: list.length <= 2 });
      remove.addEventListener("click", () => {
        change(setPath(current(), "backdrop.colors", removeColor(list, i)), false);
        sync(current());
      });
      colors.append(pick, remove);
    });
    const add = el("button", { type: "button", textContent: "+ colour", disabled: list.length >= 5 });
    add.addEventListener("click", () => {
      change(setPath(current(), "backdrop.colors", addColor(list)), false);
      sync(current());
    });
    colors.append(add);
  }

  function sync(look: Look) {
    const bd = look.backdrop;
    const shader = bd.type === "shader";
    style.value = shader ? bd.style : "";
    drawColors(shader ? (bd.colors ?? []) : []);
    for (const [path, [input, out]] of ranges) {
      const value = getPath(look, path);
      input.disabled = path.startsWith("backdrop.") && !shader;
      if (typeof value !== "number") continue;
      input.value = String(value);
      out.value = String(value);
    }
    seed.disabled = shuffle.disabled = motion.disabled = !shader;
    seed.value = shader ? String(bd.seed) : "";
    motion.checked = shader && bd.motion.enabled;
  }

  sync(current());
  return { sync };
}
```

- [ ] **Step 6: Write the page**

`editor/main.ts`:

```ts
import { BACKDROPS } from "../src/backdrops/presets.js";
import { HEARTBEAT_MS, type LookInfo, type SaveReply } from "../src/editor/protocol.js";
import { sceneLayout } from "../src/geometry.js";
import type { Look } from "../src/schema.js";
import { buildControls } from "./controls.js";
import { lookJson, windowBox } from "./state.js";
import { paintBackdrop } from "./view.js";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = byId<HTMLElement>("stage");
const scene = byId<HTMLDivElement>("scene");
const canvas = byId<HTMLCanvasElement>("backdrop");
const win = byId<HTMLDivElement>("window");
const frame = byId<HTMLImageElement>("frame");
const status = byId<HTMLSpanElement>("status");
const play = byId<HTMLButtonElement>("play");
const time = byId<HTMLInputElement>("time");
const timeOut = byId<HTMLOutputElement>("time-out");

const info = (await (await fetch("/look")).json()) as LookInfo;
const start = structuredClone(info.look);
let look = structuredClone(info.look);
let playing = false;
let frameNo = 0;
let settle: ReturnType<typeof setTimeout> | undefined;

const say = (text: string, error = false) => {
  status.textContent = text;
  status.classList.toggle("error", error);
};

/** Lays out the scene for the current look and paints it; `draft` paints a small field (spec: backdrops §6). */
function draw(draft: boolean, t = 0): void {
  const layout = sceneLayout(info.window, look, info.window.width / info.window.height);
  const s = Math.min(stage.clientWidth / layout.sceneW, stage.clientHeight / layout.sceneH);
  scene.style.width = `${layout.sceneW * s}px`;
  scene.style.height = `${layout.sceneH * s}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const long = Math.min(1600, Math.max(layout.sceneW, layout.sceneH) * s * dpr);
  const k = long / Math.max(layout.sceneW, layout.sceneH);
  canvas.width = Math.max(2, Math.round(layout.sceneW * k));
  canvas.height = Math.max(2, Math.round(layout.sceneH * k));
  paintBackdrop(canvas, look.backdrop, { t, frame: frameNo, maxField: draft ? 320 : 1280 });
  const box = windowBox(layout, look, s);
  Object.assign(win.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    borderRadius: `${box.radius}px`,
    transform: box.transform,
    boxShadow: box.shadow,
  });
  const moving = look.backdrop.type === "shader" && look.backdrop.motion.enabled;
  play.disabled = !moving;
  if (!moving && playing) togglePlay();
}

function update(next: Look, draft: boolean): void {
  look = next;
  if (playing) return; // the play loop repaints every frame
  draw(draft);
  clearTimeout(settle);
  if (draft) settle = setTimeout(() => draw(false), 200);
}

function tick(now: number): void {
  if (!playing) return;
  const t = ((now / 1000) % info.window.duration) / info.window.duration;
  frameNo++;
  draw(true, t);
  requestAnimationFrame(tick);
}

function togglePlay(): void {
  playing = !playing;
  play.textContent = playing ? "Pause" : "Play";
  play.setAttribute("aria-pressed", String(playing));
  if (playing) requestAnimationFrame(tick);
  else draw(false);
}

const controls = buildControls(byId<HTMLFormElement>("controls"), () => look, update);

const grid = byId<HTMLDivElement>("preset-grid");
for (const [name, preset] of Object.entries(BACKDROPS)) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "preset";
  button.title = preset.description;
  const thumb = document.createElement("canvas");
  thumb.width = 160;
  thumb.height = 90;
  paintBackdrop(thumb, preset.backdrop, { t: 0, frame: 0, maxField: 160 });
  const label = document.createElement("span");
  label.textContent = name;
  button.append(thumb, label);
  button.addEventListener("click", () => {
    update({ ...look, preset: name, backdrop: structuredClone(preset.backdrop) }, false);
    controls.sync(look);
  });
  grid.append(button);
}

time.max = String(info.window.duration);
time.value = String(info.hasMaster ? Math.round(info.window.duration * 5) / 10 : 0);
const showFrame = () => {
  timeOut.value = `${Number(time.value).toFixed(1)} s`;
  frame.src = `/frame?t=${time.value}`;
};
time.addEventListener("input", () => {
  timeOut.value = `${Number(time.value).toFixed(1)} s`;
});
time.addEventListener("change", showFrame);
time.disabled = !info.hasMaster;
showFrame();

play.addEventListener("click", togglePlay);
byId<HTMLButtonElement>("reset").addEventListener("click", () => {
  look = structuredClone(start);
  controls.sync(look);
  draw(false);
  say("Reset to the starting look");
});
byId<HTMLButtonElement>("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lookJson(look));
    say("Copied the look as JSON");
  } catch {
    say("The browser did not allow copying", true);
  }
});
const save = byId<HTMLButtonElement>("save");
save.addEventListener("click", async () => {
  save.disabled = true;
  try {
    const res = await fetch("/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: lookJson(look),
    });
    const reply = (await res.json()) as SaveReply;
    if ("saved" in reply) {
      clearInterval(heartbeat);
      say(`Saved to ${reply.saved}. You can close this tab.`);
      return;
    }
    say(reply.error, true);
  } catch {
    say("The editor is no longer running: nothing was saved", true);
  }
  save.disabled = false;
});

const beat = () => fetch("/heartbeat", { method: "POST" }).catch(() => say("The editor is no longer running", true));
const heartbeat = setInterval(beat, HEARTBEAT_MS);
beat();
addEventListener("pagehide", () => navigator.sendBeacon("/bye"));
addEventListener("resize", () => draw(false));
byId<HTMLElement>("out").textContent = info.out;
draw(false);
```

`editor/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>camerawork look editor</title>
    <link rel="stylesheet" href="/editor.css" />
  </head>
  <body>
    <header class="bar">
      <strong>camerawork</strong>
      <span class="muted">look editor → <code id="out"></code></span>
      <span id="status" class="status" role="status"></span>
      <button id="copy" type="button">Copy JSON</button>
      <button id="reset" type="button">Reset</button>
      <button id="save" type="button" class="primary">Save</button>
    </header>
    <main class="layout">
      <section class="left">
        <div id="stage" class="stage">
          <div id="scene" class="scene">
            <canvas id="backdrop"></canvas>
            <div id="window" class="window"><img id="frame" alt="A frame of the recording" /></div>
          </div>
        </div>
        <div class="timebar">
          <button id="play" type="button" aria-pressed="false">Play</button>
          <label>Frame at <input id="time" type="range" min="0" max="10" step="0.1" value="0" /></label>
          <output id="time-out">0.0 s</output>
        </div>
      </section>
      <aside class="panel">
        <details open>
          <summary>Presets</summary>
          <div id="preset-grid" class="grid"></div>
        </details>
        <form id="controls" autocomplete="off"></form>
      </aside>
    </main>
    <script type="module" src="/editor.js"></script>
  </body>
</html>
```

`editor/editor.css`:

```css
:root {
  color-scheme: dark;
  --bg: #0f0f12;
  --panel: #17171c;
  --line: #2a2a31;
  --text: #e7e7ea;
  --muted: #9a9aa3;
  --accent: #7b5cff;
  --error: #ff6b6b;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
}
button,
select,
input[type="number"] {
  font: inherit;
  color: var(--text);
  background: #222229;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 10px;
}
button:disabled {
  opacity: 0.4;
}
button.primary {
  background: var(--accent);
  border-color: var(--accent);
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.bar button {
  flex: none;
  white-space: nowrap;
}
.muted {
  color: var(--muted);
}
.bar .muted,
.status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status {
  flex: 1;
  text-align: right;
  color: var(--muted);
}
.status.error {
  color: var(--error);
}
.layout {
  flex: 1;
  display: flex;
  min-height: 0;
}
.left {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 16px;
  gap: 10px;
}
.stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}
.scene {
  position: relative;
  overflow: hidden;
  border-radius: 4px;
}
#backdrop {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.window {
  position: absolute;
  overflow: hidden;
  transform-origin: 0 0;
  background: #fff;
}
.window img {
  display: block;
  width: 100%;
  height: 100%;
}
.timebar {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--muted);
}
.timebar label {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
}
.timebar input {
  flex: 1;
}
.panel {
  width: 400px;
  flex: none;
  overflow-y: auto;
  border-left: 1px solid var(--line);
  background: var(--panel);
  padding: 12px 14px;
}
summary {
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 8px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}
.preset {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  font-size: 12px;
}
.preset canvas {
  width: 100%;
  border-radius: 4px;
}
fieldset {
  border: 1px solid var(--line);
  border-radius: 8px;
  margin: 0 0 12px;
  padding: 8px 10px;
}
legend {
  font-weight: 600;
  padding: 0 4px;
}
.row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr) 64px;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.row output {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.colors {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 6px 0 6px 104px;
}
.colors input[type="color"] {
  width: 34px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--line);
  background: none;
}
```

- [ ] **Step 7: Write the build script**

`scripts/build-editor.mjs`:

```js
// Bundles the look editor's page (editor/main.ts and the src/ modules it imports) for the browser with esbuild,
// next to its HTML and CSS. Usage: node scripts/build-editor.mjs [outDir]   (default dist/editor)
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, "dist", "editor"));
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, "editor", "main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: join(out, "editor.js"),
  logLevel: "warning",
});
for (const file of ["index.html", "editor.css"]) copyFileSync(join(root, "editor", file), join(out, file));
console.log(`editor → ${out}`);
```

- [ ] **Step 8: Run the tests, build, lint and typecheck**

Run: `bun test test/editor-page.test.ts && bun run build && ls dist/editor && bunx biome check . && bunx tsc --noEmit`
Expected: PASS (6 tests); `dist/editor` lists `editor.css editor.js index.html` (plus `server.js` and `protocol.js` once Task 8 is merged); `editor.js` ≈ 21 KB.

- [ ] **Step 9: Commit**

```bash
git add editor scripts/build-editor.mjs package.json bun.lock tsconfig.json biome.json .github/workflows/ci.yml test/editor-page.test.ts
git commit -m "feat(editor): look editor page bundled with esbuild into dist/editor"
```

---

### Task 10: `looks`, `look preview` and `look edit` commands

**Files:**
- Create: `src/look-preview.ts`
- Modify: `src/cli.ts` (whole file), `src/index.ts` (whole file), `README.md` (CLI reference), `skills/camerawork/SKILL.md` (Workflow step 2 and the Looks section)
- Test: `test/look-commands.test.ts`

**Interfaces:**
- Consumes: Task 5 (`BACKDROPS`, `LOOKS`, `LOOK_DESCRIPTIONS`, `resolveLook`), Task 7 (`makeLookAssets`, `sceneArgs`), Task 8 (`startEditor`, `openUrl`, `PLACEHOLDER`, `placeholderWindow`), Task 9 (`scripts/build-editor.mjs`).
- Produces (exact):
  - `src/look-preview.ts`: `interface LookPreviewOptions { out: string; master?: string; at?: number; width?: number }`; `lookPreview(look: Look, opts: LookPreviewOptions): Promise<string>`.
  - CLI: `camerawork looks`; `camerawork look preview <preset|look.json> -o <look.png> [--master <video>] [--at seconds] [--width N]`; `camerawork look edit -o <look.json> [--master <video>] [--look <preset|look.json>] [--port N] [--no-open]` (exit 0 after a save, 1 when closed without saving, `CAMERAWORK_EDITOR_IDLE_MS` overrides the idle timeouts). New flags are allowed only on these commands (exit 2 elsewhere).
  - Library exports: `STYLE_NAMES`, `STYLES`, `StyleName`, `BACKDROPS`, `BackdropPreset`, `startEditor`, `openUrl`, `EditorOptions`, `EditorSession`, `lookPreview`, `LookPreviewOptions`, `LOOK_DESCRIPTIONS` (plus everything exported today).

`test/docs.test.ts` already requires the README and the skill to mention every flag in the CLI usage, so the docs for the new flags land in this task.

- [ ] **Step 1: Write the failing tests**

`test/look-commands.test.ts` (Review Focus 5 at the CLI: a bad or busy `--port`):

```ts
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { BACKDROPS } from "../src/backdrops/presets.js";
import { startEditor } from "../src/editor/server.js";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS, resolveLook } from "../src/looks.js";
import { PLACEHOLDER } from "../src/placeholder.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

const CLI = join(import.meta.dir, "../src/cli.ts");
const cli = (...args: string[]) => spawnSync("bun", [CLI, ...args], { encoding: "utf8" });

/** Starts the CLI and resolves the editor URL from its first line, and its exit once it ends. */
function background(args: string[], env: Record<string, string> = {}) {
  const proc = spawn("bun", [CLI, ...args], { env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d;
  });
  const url = new Promise<string>((ok) => {
    proc.stdout.on("data", (d) => {
      stdout += d;
      const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
      if (m) ok(m[0]);
    });
  });
  const exit = new Promise<{ code: number | null; stdout: string; stderr: string }>((ok) =>
    proc.on("close", (code) => ok({ code, stdout, stderr })),
  );
  return { url, exit };
}

describe("camerawork looks", () => {
  test("lists every look and backdrop preset with a description", () => {
    const r = cli("looks");
    expect(r.status).toBe(0);
    for (const name of [...Object.keys(LOOKS), ...Object.keys(BACKDROPS)]) expect(r.stdout).toContain(`  ${name} `);
    expect(r.stdout).toContain(BACKDROPS.ultraviolet?.description as string);
  });
});

describe("camerawork look preview", () => {
  test("writes a PNG of the scene size, or of --width, with a placeholder window", async () => {
    const dir = tmpDir();
    expect(cli("look", "preview", "ultraviolet", "-o", join(dir, "uv.png")).status).toBe(0);
    const layout = sceneLayout(PLACEHOLDER, resolveLook("ultraviolet"), 16 / 9);
    const full = await loadImage(join(dir, "uv.png"));
    expect([full.width, full.height]).toEqual([layout.sceneW, layout.sceneH]);
    expect(cli("look", "preview", "hero", "-o", join(dir, "hero.png"), "--width", "640").status).toBe(0);
    const small = await loadImage(join(dir, "hero.png"));
    expect([small.width, small.height]).toEqual([640, Math.round((layout.sceneH * 640) / layout.sceneW)]);
  }, 60_000);

  test("uses a frame of --master at --at, and refuses a time outside it", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 2, boxes: [] });
    const look = join(dir, "look.json");
    writeFileSync(look, JSON.stringify({ ...LOOKS.hero, backdrop: { type: "shader", style: "mesh" } }));
    const ok = cli("look", "preview", look, "--master", master, "--at", "1", "-o", join(dir, "p.png"));
    expect(ok.status).toBe(0);
    expect(existsSync(join(dir, "p.png"))).toBe(true);
    const late = cli("look", "preview", "hero", "--master", master, "--at", "9", "-o", join(dir, "q.png"));
    expect(late.status).toBe(1);
    expect(late.stderr).toContain("--at 9 is outside the master");
  }, 60_000);

  test("usage errors exit 2; an unknown preset exits 1 naming the choices", () => {
    expect(cli("look", "preview", "hero").status).toBe(2);
    expect(cli("look", "preview", "hero", "-o", "x.png", "--port", "1").status).toBe(2);
    expect(cli("look", "frobnicate").status).toBe(2);
    const r = cli("look", "preview", "sparkly", "-o", join(tmpDir(), "x.png"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("backdrops: ultraviolet");
  });
});

describe("plan --look <backdrop preset>", () => {
  test("records the hero window on that backdrop in plan.json", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const r = cli("plan", master, "-o", join(dir, "plan.json"), "--look", "dusk", "--width", "640");
    expect(r.status).toBe(0);
    const p = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
    expect(p.look.preset).toBe("dusk");
    expect(p.look.backdrop).toEqual(BACKDROPS.dusk?.backdrop);
    expect(p.look.padding).toBe(0.09);
  }, 60_000);
});

describe("camerawork look edit", () => {
  test("prints the URL, saves through the page's endpoint and exits 0", async () => {
    const out = join(tmpDir(), "my look.json");
    const run = background(["look", "edit", "-o", out, "--look", "glacier", "--no-open"]);
    const url = await run.url;
    const look = (await (await fetch(new URL("/look", url))).json()) as { look: unknown };
    const reply = await fetch(new URL("/save", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(look.look),
    });
    expect(reply.status).toBe(200);
    const { code, stdout } = await run.exit;
    expect(code).toBe(0);
    expect(stdout).toContain(`saved ${out}`);
    expect(JSON.parse(readFileSync(out, "utf8")).backdrop).toEqual(BACKDROPS.glacier?.backdrop);
  }, 30_000);

  test("exits 1 without writing when nobody saves before the idle timeout", async () => {
    const out = join(tmpDir(), "look.json");
    const run = background(["look", "edit", "-o", out, "--no-open"], { CAMERAWORK_EDITOR_IDLE_MS: "300" });
    const { code, stderr } = await run.exit;
    expect(code).toBe(1);
    expect(stderr).toContain("closed without saving; nothing was written");
    expect(existsSync(out)).toBe(false);
  }, 30_000);

  test("a bad or busy --port is reported before anything starts (Review Focus 5)", async () => {
    const out = join(tmpDir(), "look.json");
    expect(cli("look", "edit", "-o", out, "--port", "70000").status).toBe(2);
    const blocker = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = String((blocker.address() as { port: number }).port);
    try {
      const r = cli("look", "edit", "-o", out, "--port", port, "--no-open");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`port ${port} is already in use`);
    } finally {
      blocker.close();
    }
  });

  test("serves the real built page (the server and page agree on file names)", async () => {
    const assetsDir = join(tmpDir(), "editor");
    expect(spawnSync("node", [join(import.meta.dir, "../scripts/build-editor.mjs"), assetsDir]).status).toBe(0);
    const session = await startEditor({ out: join(tmpDir(), "l.json"), look: resolveLook("hero"), assetsDir });
    try {
      const page = await (await fetch(session.url)).text();
      expect(page).toContain("camerawork look editor");
      const js = await fetch(new URL("/editor.js", session.url));
      expect(js.status).toBe(200);
      expect((await js.text()).length).toBeGreaterThan(5000);
      expect((await fetch(new URL("/editor.css", session.url))).status).toBe(200);
    } finally {
      await session.close();
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test test/look-commands.test.ts`
Expected: FAIL (`unknown command "looks"`, exit 2).

- [ ] **Step 3: Write the look preview**

`src/look-preview.ts`:

```ts
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { CameraworkError } from "./errors.js";
import { probe, readFrames, requireFfmpeg } from "./ffmpeg.js";
import { sceneLayout } from "./geometry.js";
import { PLACEHOLDER, placeholderWindow } from "./placeholder.js";
import { makeLookAssets } from "./render/assets.js";
import { sceneArgs } from "./render/scene.js";
import type { Look } from "./schema.js";

export interface LookPreviewOptions {
  /** The PNG to write. */
  out: string;
  /** A master video: the window shows its frame at `at`. Without it, a neutral placeholder window. */
  master?: string;
  /** Seconds into the master (default: the middle). */
  at?: number;
  /** Output width in pixels (default: the scene's width). */
  width?: number;
}

/**
 * One composed still of a look (spec: backdrops §5): the backdrop (an animated one at loop time 0), shadow and the
 * window, through the same scene graph as render. Returns the PNG's path.
 */
export async function lookPreview(look: Look, opts: LookPreviewOptions): Promise<string> {
  requireFfmpeg();
  if (opts.width !== undefined && (!Number.isInteger(opts.width) || opts.width < 16))
    throw new CameraworkError(`--width must be a whole number of pixels, at least 16 (got ${opts.width})`);
  const work = mkdtempSync(join(tmpdir(), "camerawork-look-"));
  const tmp = `${opts.out}.tmp-${process.pid}.png`;
  try {
    let source: string;
    let size: { width: number; height: number };
    const seek: string[] = [];
    if (opts.master) {
      const info = probe(opts.master);
      const at = opts.at ?? info.duration / 2;
      if (!(at >= 0 && at < info.duration))
        throw new CameraworkError(`--at ${at} is outside the master (0 to ${info.duration.toFixed(2)} s)`);
      source = opts.master;
      size = info;
      seek.push("-ss", at.toFixed(3));
    } else {
      source = join(work, "window.png");
      writeFileSync(source, placeholderWindow());
      size = PLACEHOLDER;
    }
    const layout = sceneLayout(size, look, size.width / size.height);
    const assets = await makeLookAssets(layout, look, work);
    let scene: Buffer | null = null;
    await readFrames(
      [...seek, ...sceneArgs(source, layout, assets, 30), "-frames:v", "1"],
      layout.sceneW * layout.sceneH * 4,
      (f) => {
        scene = Buffer.from(f);
      },
    );
    if (!scene) throw new CameraworkError(`no frame of ${source} at the requested time`);
    const pixels = scene as Buffer;
    const full = createCanvas(layout.sceneW, layout.sceneH);
    full
      .getContext("2d")
      .putImageData(
        new ImageData(
          new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length),
          layout.sceneW,
          layout.sceneH,
        ),
        0,
        0,
      );
    const w = opts.width ?? layout.sceneW;
    const h = Math.max(1, Math.round((layout.sceneH * w) / layout.sceneW));
    const outCanvas = w === layout.sceneW ? full : createCanvas(w, h);
    if (outCanvas !== full) {
      const ctx = outCanvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(full, 0, 0, w, h);
    }
    try {
      writeFileSync(tmp, outCanvas.toBuffer("image/png"));
    } catch (error) {
      throw new CameraworkError(`cannot write ${opts.out}: ${(error as Error).message}`);
    }
    renameSync(tmp, opts.out);
    return opts.out;
  } finally {
    rmSync(tmp, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Add the commands to the CLI**

Replace `src/cli.ts` with:

```ts
#!/usr/bin/env node
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BACKDROPS } from "./backdrops/presets.js";
import { detect } from "./detect/index.js";
import { openUrl, startEditor } from "./editor/server.js";
import { CameraworkError } from "./errors.js";
import { lookPreview } from "./look-preview.js";
import { LOOK_DESCRIPTIONS, LOOKS, resolveLook } from "./looks.js";
import { plan, readChangesFile, readCueFile, readJson, readPlan, writeJsonAtomic } from "./plan/index.js";
import { preview } from "./preview.js";
import { render } from "./render/index.js";
import type { Look, Rect } from "./schema.js";

const USAGE = `Usage:
  camerawork detect <master> -o <changes.json> [--mask x,y,w,h]...
  camerawork plan <master> -o <plan.json> [--cues f] [--changes f] [--look <preset|look.json>] [--loop]
                  [--width N] [--fps N] [--formats mp4,webm] [--poster jpg|webp|none] [--max-bytes N]
                  [--quality medium|high] [--max-zoom N] [--min-hold N] [--mask x,y,w,h]...
  camerawork preview <plan.json> [-o <prefix>]
  camerawork render <plan.json> -o <prefix>
  camerawork looks
  camerawork look preview <preset|look.json> -o <look.png> [--master <video>] [--at seconds] [--width N]
  camerawork look edit -o <look.json> [--master <video>] [--look <preset|look.json>] [--port N] [--no-open]
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
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)))
    throw new UsageError(`--mask must be x,y,w,h, got "${v}"`);
  return parts as Rect;
};

const OUTPUT_FLAGS = ["width", "fps", "formats", "poster", "max-bytes", "quality", "loop", "look"];
const PLAN_FLAGS = [...OUTPUT_FLAGS, "out", "mask", "cues", "changes", "max-zoom", "min-hold"];
const ALLOWED: Record<string, string[]> = {
  detect: ["out", "mask"],
  plan: PLAN_FLAGS,
  preview: ["out"],
  render: ["out"],
  looks: [],
  "look preview": ["out", "master", "at", "width"],
  "look edit": ["out", "master", "look", "port", "no-open"],
};

/** Exit 2 for any flag the command does not take. */
function checkFlags(command: string, given: string[]): void {
  const allowed = ALLOWED[command];
  if (!allowed) return;
  for (const flag of given) {
    if (allowed.includes(flag) || flag === "version" || flag === "help") continue;
    if ((command === "render" || command === "preview") && OUTPUT_FLAGS.includes(flag))
      throw new UsageError(
        `--${flag} is not an option of ${command}: set output options when planning: camerawork plan <master> -o <plan.json> --${flag} …`,
      );
    throw new UsageError(`--${flag} is not an option of ${command}`);
  }
}

/** Fails now, before any expensive work, when the output's directory is missing or not writable. */
function checkOutputDir(out: string): void {
  const dir = resolve(dirname(out));
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
    if (ok) accessSync(dir, constants.W_OK);
  } catch {
    ok = false;
  }
  if (!ok)
    throw new CameraworkError(
      `cannot write ${out}: the directory ${dir} does not exist or is not writable. Create it or choose another -o.`,
    );
}

/** A look argument: a path ending in .json is read as a look file; anything else is a preset name. */
const lookArg = (v: string | undefined): string | Look | undefined =>
  v?.endsWith(".json") ? (readJson(v) as Look) : v;

/** `camerawork looks`: every look preset and backdrop preset, one line each. */
function listLooks(): string {
  const pad = Math.max(...[...Object.keys(LOOKS), ...Object.keys(BACKDROPS)].map((n) => n.length)) + 2;
  const lines = ["Looks (the window and its backdrop):"];
  for (const [name, text] of Object.entries(LOOK_DESCRIPTIONS)) lines.push(`  ${name.padEnd(pad)}${text}`);
  lines.push("", "Backdrops (--look <name> puts the hero window on it):");
  for (const [name, preset] of Object.entries(BACKDROPS)) lines.push(`  ${name.padEnd(pad)}${preset.description}`);
  return lines.join("\n");
}

/** The editor's idle timeout: CAMERAWORK_EDITOR_IDLE_MS (a test knob), else the server's defaults. */
function idleKnob(): { idleMs?: number; firstContactMs?: number } {
  const ms = Number(process.env.CAMERAWORK_EDITOR_IDLE_MS);
  return Number.isFinite(ms) && ms > 0 ? { idleMs: ms, firstContactMs: ms } : {};
}

const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

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
      master: { type: "string" },
      at: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version) {
    console.log(version());
    return;
  }
  const [command, input, lookInput] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const need = (v: string | undefined, what: string): string => {
    if (!v) throw new UsageError(`${command} needs ${what}`);
    return v;
  };
  checkFlags(command === "look" ? `look ${input ?? ""}` : command, Object.keys(values));
  if (command === "detect" || command === "plan" || command === "render")
    checkOutputDir(
      need(
        values.out,
        command === "plan" ? "-o <plan.json>" : command === "detect" ? "-o <changes.json>" : "-o <prefix>",
      ),
    );
  if (command === "preview" && values.out) checkOutputDir(values.out);
  if (command === "look" && (input === "preview" || input === "edit"))
    checkOutputDir(need(values.out, input === "preview" ? "-o <look.png>" : "-o <look.json>"));
  const masks = (values.mask ?? []).map(rect);
  switch (command) {
    case "detect": {
      const changes = await detect(need(input, "a master video"), { masks });
      writeJsonAtomic(need(values.out, "-o <changes.json>"), changes);
      console.log(`${changes.changes.length} changes → ${values.out}`);
      return;
    }
    case "plan": {
      const look = lookArg(values.look);
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
        planner: defined({
          maxZoom: num("max-zoom", values["max-zoom"]),
          minHold: num("min-hold", values["min-hold"]),
        }),
      });
      writeJsonAtomic(need(values.out, "-o <plan.json>"), p);
      console.log(
        `${p.shots.length} shots, ${p.keyframes.length} keyframes, max zoom ${p.maxZoom.toFixed(2)} → ${values.out}`,
      );
      return;
    }
    case "preview": {
      const planPath = need(input, "a plan.json");
      const { sheet, debug } = await preview(readPlan(planPath), {
        out: values.out ?? planPath.replace(/\.json$/, ""),
      });
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
    case "looks":
      console.log(listLooks());
      return;
    case "look": {
      if (input === "preview") {
        const look = resolveLook(lookArg(need(lookInput, "a look preset or look.json")) as string | Look);
        const png = await lookPreview(look, {
          out: need(values.out, "-o <look.png>"),
          master: values.master,
          at: num("at", values.at),
          width: num("width", values.width),
        });
        console.log(png);
        return;
      }
      if (input === "edit") {
        const port = num("port", values.port);
        if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535))
          throw new UsageError(`--port must be a whole number from 0 to 65535, got "${values.port}"`);
        const session = await startEditor({
          out: need(values.out, "-o <look.json>"),
          look: resolveLook(lookArg(values.look) ?? "hero"),
          master: values.master,
          port,
          ...idleKnob(),
        });
        console.log(`camerawork look editor: ${session.url}  (Save in the page to write ${values.out})`);
        if (!values["no-open"] && !(await openUrl(session.url)))
          console.error(`camerawork: could not open a browser; open ${session.url} yourself`);
        const saved = await session.done;
        if (!saved) throw new CameraworkError("the editor was closed without saving; nothing was written");
        console.log(`saved ${saved}`);
        return;
      }
      throw new UsageError(`unknown look command "${input ?? ""}" (use: look preview, look edit)`);
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

- [ ] **Step 5: Export the new API**

Replace `src/index.ts` with:

```ts
export { STYLE_NAMES, STYLES, type StyleName } from "./backdrops/index.js";
export { BACKDROPS, type BackdropPreset } from "./backdrops/presets.js";
export { type DetectOptions, detect } from "./detect/index.js";
export { type EditorOptions, type EditorSession, openUrl, startEditor } from "./editor/server.js";
export { CameraworkError } from "./errors.js";
export { type LookPreviewOptions, lookPreview } from "./look-preview.js";
export { LOOK_DESCRIPTIONS, LOOKS, resolveLook } from "./looks.js";
export { type PlanOptions, plan, readChangesFile, readCueFile, readPlan, writeJsonAtomic } from "./plan/index.js";
export { type PreviewOptions, preview } from "./preview.js";
export { checkSharpness, type RenderOptions, render } from "./render/index.js";
export * from "./schema.js";
```

- [ ] **Step 6: Document the commands in the README's CLI reference**

In `README.md`, replace the usage block under `## CLI reference`:

````
```
camerawork detect <master> -o <changes.json> [--mask x,y,w,h]...
camerawork plan <master> -o <plan.json> [--cues f] [--changes f] [--look hero|flat|look.json] [--loop]
                [--width N] [--fps N] [--formats mp4,webm] [--poster jpg|webp|none] [--max-bytes N]
                [--quality medium|high] [--max-zoom N] [--min-hold N] [--mask x,y,w,h]...
camerawork preview <plan.json> [-o <prefix>]
camerawork render <plan.json> -o <prefix>
camerawork --version
```
````

with:

````
```
camerawork detect <master> -o <changes.json> [--mask x,y,w,h]...
camerawork plan <master> -o <plan.json> [--cues f] [--changes f] [--look <preset|look.json>] [--loop]
                [--width N] [--fps N] [--formats mp4,webm] [--poster jpg|webp|none] [--max-bytes N]
                [--quality medium|high] [--max-zoom N] [--min-hold N] [--mask x,y,w,h]...
camerawork preview <plan.json> [-o <prefix>]
camerawork render <plan.json> -o <prefix>
camerawork looks
camerawork look preview <preset|look.json> -o <look.png> [--master <video>] [--at seconds] [--width N]
camerawork look edit -o <look.json> [--master <video>] [--look <preset|look.json>] [--port N] [--no-open]
camerawork --version
```
````

In the `plan` flag table replace the `--look` row:

```
| `--look <name or file>` | `hero` | `hero`, `flat`, or a path ending in `.json` with a [look](#looks). |
```

with:

```
| `--look <name or file>` | `hero` | A look preset (`hero`, `flat`), a [backdrop preset](#backdrops) (the hero window on that backdrop), or a path ending in `.json` with a [look](#looks). |
```

Insert before the line `` ### `--version`, `--help` ``:

````markdown
### `looks`

`camerawork looks` lists the look presets and the backdrop presets, one line each.

### `look preview`

`camerawork look preview <preset|look.json> -o look.png` renders one still of a look (the backdrop, the shadow and the
window, through the same scene graph as `render`) and prints its path. An animated backdrop is shown at its first
frame.

| Flag | Default | Meaning |
|---|---|---|
| `-o <look.png>` | required | Output PNG. |
| `--master <video>` | a placeholder | Show a frame of this recording in the window (else a neutral 1920×1080 window mock). |
| `--at seconds` | the middle | Which frame of `--master`. |
| `--width N` | the scene's width | Width of the PNG. |

### `look edit`

`camerawork look edit -o my-look.json` starts the [look editor](#look-editor) on `127.0.0.1`, prints its URL and
opens it in the browser. It exits 0 once you press Save (the look is written to `-o`), or 1 with nothing written if
the page is closed without saving.

| Flag | Default | Meaning |
|---|---|---|
| `-o <look.json>` | required | Where Save writes the look. |
| `--master <video>` | a placeholder | Preview on frames of this recording. |
| `--look <preset or file>` | `hero` | The starting look. |
| `--port N` | a free port | Listen on this port. |
| `--no-open` | off | Do not open a browser; just print the URL (for headless machines and agents). |
````

- [ ] **Step 7: Document the look choice in the skill**

In `skills/camerawork/SKILL.md`, Workflow step 2, replace:

```
2. **Plan.** `camerawork plan master.mov -o plan.json --look hero --loop`
```

with:

```
2. **Choose a look** (see Looks below), then **plan.** `camerawork plan master.mov -o plan.json --look hero --loop`
```

Replace the whole `## Looks` section (from `## Looks` up to, not including, `## Errors worth knowing`) with:

````markdown
## Looks

Before planning, ask the user which they want: the default `hero` look, a preset, or a look customised in the editor.

- **Default:** `--look hero` (gray gradient, 9 % padding, rounded corners, shadow). `--look flat` is the window alone.
- **A preset:** `camerawork looks` lists the look and backdrop presets. Any backdrop preset works as a look:
  `--look ultraviolet` is the hero window on the `ultraviolet` backdrop. Pick 2–3 that suit the product, render a
  still of each on the user's recording, open the PNGs and look at them, show them to the user and let them choose:

  ```bash
  camerawork look preview ultraviolet --master master.mov -o /tmp/look-ultraviolet.png --width 960
  ```

  `--at seconds` picks the frame (default: the middle).
- **Customise:** start the editor in the background and give the user the URL it prints:

  ```bash
  camerawork look edit --master master.mov -o <dir>/look.json --look ultraviolet
  ```

  It opens a browser page (add `--no-open` when there is no browser on this machine, and `--port N` for a fixed
  port). Wait for the command to exit: exit 0 means the user pressed Save and `<dir>/look.json` exists; exit 1 means
  the page was closed without saving (nothing written). Then `camerawork plan master.mov -o plan.json --look
  <dir>/look.json`.

A look file is a full object with `backdrop`, `padding`, `radius`, `shadow` and `tilt`. `backdrop` can be a gradient,
a solid colour, `{ "type": "image", "path": "bg.jpg" }` (relative to the plan file), or a procedural
`{ "type": "shader", "style": "silk", "colors": [...], "motion": { "enabled": true, "speed": 0.3 } }` (styles: silk,
waves, aurora, mesh, stripes, ripple, linear, radial, conic). Motion makes the backdrop loop seamlessly over the
video; it costs render time (roughly 20–45 ms per frame on 8 cores).
````

- [ ] **Step 8: Run the tests, the whole suite, lint and typecheck**

Run: `bun test test/look-commands.test.ts test/docs.test.ts test/cli.test.ts && bun run test && bunx biome check . && bunx tsc --noEmit`
Expected: PASS (9 new tests; docs and cli tests green).

- [ ] **Step 9: Try it by hand**

Run: `bun src/cli.ts looks && bun src/cli.ts look preview ultraviolet -o /tmp/uv.png --width 960`
Expected: the list of 2 looks and 19 backdrops; then `/tmp/uv.png`. Open the PNG: a violet silk backdrop with a light window mock, rounded corners and a soft shadow.

- [ ] **Step 10: Commit**

```bash
git add src/look-preview.ts src/cli.ts src/index.ts README.md skills/camerawork/SKILL.md test/look-commands.test.ts
git commit -m "feat(cli): looks, look preview and look edit"
```

---

### Task 11: README backdrop and editor docs, NOTICE, presets contact sheet

**Files:**
- Create: `NOTICE`, `scripts/presets-sheet.ts`, `docs/images/backdrop-presets.jpg` (generated)
- Modify: `README.md` (What it does, Looks, new Backdrops and Look editor sections, Library API, Development, License), `package.json` (`files`), `test/docs.test.ts`

**Interfaces:**
- Consumes: Task 5 (`BACKDROPS`, `STYLE_NAMES`), Task 7 (`backdropCanvas`).
- Produces: `bun scripts/presets-sheet.ts [out.jpg]` writes a 4-column, 1920-px-wide JPEG of every backdrop preset (480×270 tiles with a window mock and the name); `NOTICE` ships in the package.

- [ ] **Step 1: Write the failing docs tests**

In `test/docs.test.ts`, add after `import { join } from "node:path";`:

```ts
import { loadImage } from "@napi-rs/canvas";
import { STYLE_NAMES } from "../src/backdrops/index.js";
import { BACKDROPS } from "../src/backdrops/presets.js";
```

In the skill test's word list, after `"raw.githubusercontent.com/GustavoGomez092/camerawork/main/skills/camerawork/install.sh",` add:

```ts
      "camerawork looks",
      "camerawork look preview",
      "camerawork look edit --master",
      "Before planning, ask the user",
```

In the README test's word list, after `"ffmpeg",` add:

```ts
      "camerawork looks",
      "camerawork look preview",
      "camerawork look edit",
      "## Backdrops",
      "## Look editor",
      "docs/images/backdrop-presets.jpg",
      "NOTICE",
```

and after that test (before `test("README and the skill document every flag of the CLI usage"`) add:

```ts
  test("every backdrop preset and style is in the README, and the contact sheet is committed", async () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    for (const name of [...Object.keys(BACKDROPS), ...STYLE_NAMES]) expect(readme).toContain(`\`${name}\``);
    const sheet = await loadImage(join(root, "docs/images/backdrop-presets.jpg"));
    expect(sheet.width).toBe(1920);
  });

  test("NOTICE credits gradflow and ships with the package", () => {
    const notice = readFileSync(join(root, "NOTICE"), "utf8");
    expect(notice).toContain("github.com/meerbahadin/gradflow");
    expect(notice).toContain("MIT");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("NOTICE");
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test test/docs.test.ts`
Expected: FAIL (`## Backdrops` missing, `docs/images/backdrop-presets.jpg` missing, no `NOTICE`).

- [ ] **Step 3: Write NOTICE and ship it**

`NOTICE` (gradflow states "MIT License" in its README and has no LICENSE file; no gradflow code is used):

```
camerawork
Copyright (c) the camerawork contributors. Licensed under the MIT License (see LICENSE).

The look and feel of camerawork's procedural backdrops (silk, aurora, stripes and the other styles) was inspired by:

  gradflow, animated WebGL gradients for React, by Meer Bahadin
  https://github.com/meerbahadin/gradflow
  MIT License

camerawork contains no gradflow code: its backdrop styles are original CPU implementations written for camerawork.
```

In `package.json` replace:

```json
    "README.md",
    "LICENSE"
  ],
```

with:

```json
    "README.md",
    "LICENSE",
    "NOTICE"
  ],
```

- [ ] **Step 4: Generate the contact sheet**

`scripts/presets-sheet.ts`:

```ts
// Renders the README's contact sheet of every backdrop preset, each with the hero window on it.
// Usage: bun scripts/presets-sheet.ts [out.jpg]   (default docs/images/backdrop-presets.jpg)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { BACKDROPS } from "../src/backdrops/presets.js";
import { backdropCanvas } from "../src/render/assets.js";

const W = 480;
const H = 270;
const COLUMNS = 4;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, "docs/images/backdrop-presets.jpg"));
const names = Object.keys(BACKDROPS);
const sheet = createCanvas(COLUMNS * W, Math.ceil(names.length / COLUMNS) * H);
const ctx = sheet.getContext("2d");
for (const [i, name] of names.entries()) {
  const x = (i % COLUMNS) * W;
  const y = Math.floor(i / COLUMNS) * H;
  ctx.drawImage(await backdropCanvas((BACKDROPS[name] as (typeof BACKDROPS)[string]).backdrop, W, H), x, y);
  // a small window mock, so the backdrop stays visible: rounded corners and a soft shadow
  const padX = W * 0.16;
  const padY = H * 0.16;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = "#f5f5f7";
  ctx.beginPath();
  ctx.roundRect(x + padX, y + padY, W - 2 * padX, H - 2 * padY - 20, 6);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x, y + H - 26, W, 26);
  ctx.fillStyle = "#ffffff";
  ctx.font = "15px sans-serif";
  ctx.fillText(name, x + 10, y + H - 8);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, sheet.toBuffer("image/jpeg", 85));
console.log(out);
```

Run: `bun scripts/presets-sheet.ts`
Expected: prints the path of `docs/images/backdrop-presets.jpg` (≈ 200 KB, 1920×1350). Open it and check every tile: no tile is flat or broken, names are readable.

- [ ] **Step 5: Write the README sections**

In `README.md`, replace item 4 of `## What it does`:

```
4. **A presentation look**: the window sits on a backdrop with padding, rounded corners and a shadow.
```

with:

```
4. **A presentation look**: the window sits on a backdrop with padding, rounded corners and a shadow. Backdrops can
   be procedural (silky light, aurora ribbons, mesh gradients, film grain), still or seamlessly animated, picked
   from presets or designed in a local [look editor](#look-editor).
```

Replace the whole `## Looks` section (from `## Looks` up to, not including, `## Library API`) with:

````markdown
## Looks

A look is the presentation around the window. Pick one with `--look`:

- `hero`: a gray gradient backdrop, `padding` 0.09, `radius` 18, a soft shadow, no tilt.
- `flat`: the window alone: no backdrop, padding, rounding or shadow.
- any [backdrop preset](#backdrops), such as `--look ultraviolet`: the `hero` window on that backdrop.
- a JSON file, `--look my-look.json` (write one by hand or with `camerawork look edit`).

`camerawork looks` lists them all. A custom look is a full object (all fields required except `preset`):

```json
{
  "preset": "my-look",
  "backdrop": { "type": "image", "path": "bg.jpg" },
  "padding": 0.1,
  "radius": 18,
  "shadow": { "blur": 60, "offsetY": 24, "opacity": 0.55 },
  "tilt": { "rotateX": 0, "rotateY": 0, "perspective": 2400 }
}
```

| Field | Meaning |
|---|---|
| `backdrop` | One of `{ "type": "gradient", "angle": 180, "stops": [{ "at": 0, "color": "#8f8f8f" }, …] }` (at least two stops, `at` from 0 to 1), `{ "type": "solid", "color": "#101010" }`, `{ "type": "image", "path": "bg.jpg" }`, `{ "type": "none" }`, or a [shader backdrop](#backdrops). Colors are `#rrggbb`. An image path is stored absolute in the plan; a relative one counts from the plan file's folder. |
| `padding` | Space around the window as a fraction of the width, 0 to 0.45. |
| `radius` | Corner radius in pixels at a 1920-px-wide window. |
| `shadow` | `blur` and `offsetY` in pixels (same scale), `opacity` 0 to 1. |
| `tilt` | A fixed 3D tilt: `rotateX` and `rotateY` in degrees (-30 to 30), `perspective` in pixels. |

## Backdrops

![Every backdrop preset](docs/images/backdrop-presets.jpg)

A shader backdrop is drawn procedurally by camerawork itself (no GPU, no browser), the same way in the render and in
the editor, and the same settings always give the same pixels:

```json
"backdrop": { "type": "shader", "style": "silk",
  "colors": ["#1a0b3d", "#ff2bd6", "#7b2bff"], "angle": 62, "scale": 1.0,
  "distortion": 0.4, "seed": 7, "grain": 0.06, "vignette": 0.2,
  "motion": { "enabled": false, "speed": 0.3 } }
```

| Style | Look |
|---|---|
| `silk` | soft diagonal bands of light with a sheen, like folded fabric |
| `waves` | layered flowing waves, stacked along the angle |
| `aurora` | wide glowing ribbons over a dark base (the first colour) |
| `mesh` | soft colour blobs blended together (placed by the seed) |
| `stripes` | crisp diagonal bands with soft edges and depth shading |
| `ripple` | zig-zag interference ripples |
| `linear`, `radial`, `conic` | classic gradients |

| Setting | Range | Default | Meaning |
|---|---|---|---|
| `style` | above | required | The pattern. |
| `colors` | 2–5 `#rrggbb` | the style's palette | Mixed in OKLab, so blends stay vivid. |
| `angle` | 0–360 | 45 | Direction, in degrees as in CSS (0 up, 90 right). |
| `scale` | 0.2–5 | 1 | Pattern size: 2 makes every feature twice as large. |
| `distortion` | 0–1 | 0.3 | How much noise bends the pattern. |
| `seed` | integer | 1 | Picks the noise and blob positions. |
| `grain` | 0–0.3 | 0.04 | Film grain, added at full resolution. |
| `vignette` | 0–1 | 0 | Darkens the edges. |
| `motion` | `{ enabled, speed 0.05–2 }` | off, 0.3 | Animates the backdrop: one seamless loop over the video's length. |

Backdrop presets (`camerawork looks` describes each): `ultraviolet`, `glacier`, `raspberry`, `frost`, `chrome` (silk),
`aurora`, `dusk`, `midnight`, `ember`, `graphite` (stripes), `petal` (mesh), `ripple-sea` (ripple), `solar` (waves),
`horizon` (linear), `halo` (radial), `prism` (conic), and the plain `hero` gradient, `solid` and `none`.

How it renders: the pattern is computed at up to 1280 px on the long side, upscaled to the scene with high-quality
resampling, then grained at full size. A still backdrop costs about a second for a 4K master. With `motion`, every
frame of one loop (the master's duration at the output fps) is computed on worker threads, about 20–45 ms per frame
on an 8-core machine, into a temporary video that the scene graph loops, upscales and grains; a 5-second 1080p
master renders in about 11 s instead of 6 s. `speed` sets how far the pattern travels in one loop, so the first and
last frames always meet.

## Look editor

```bash
camerawork look edit --master master.mov -o my-look.json
```

A local page (served on `127.0.0.1` only) for designing a whole look on a real frame of your recording: pick a preset
from the grid of live thumbnails, then adjust the style, colours, angle, scale, distortion, seed, grain, vignette and
motion, and the window's padding, corner radius, shadow and tilt. The time slider picks the frame; Play animates a
moving backdrop. Save writes `my-look.json` (validated like any look file) and ends the command; Copy JSON copies the
look; Reset goes back to the starting look. Without `--master` the window is a neutral placeholder. Use the file with
`camerawork plan master.mov -o plan.json --look my-look.json`.
````

In `## Library API`, replace:

```
- Helpers: `readPlan`, `readCueFile`, `readChangesFile`, `writeJsonAtomic`, `resolveLook`, `LOOKS`,
  `checkSharpness`, and `CameraworkError`
```

with:

```
- `lookPreview(look, { out, master?, at?, width? })` writes one composed still of a look and returns its path.
- `startEditor({ out, look, master?, port? })` starts the look editor and returns `{ url, port, done, close }`;
  `done` resolves with the saved path, or `null` if the session ended without a save. `openUrl(url)` opens a browser.
- Presets: `LOOKS`, `LOOK_DESCRIPTIONS`, `BACKDROPS` (name → `{ description, backdrop }`), `STYLES`, `STYLE_NAMES`.
- Helpers: `readPlan`, `readCueFile`, `readChangesFile`, `writeJsonAtomic`, `resolveLook`,
  `checkSharpness`, and `CameraworkError`
```

and replace ``- Types: `Plan`, `Look`, `Backdrop`, `OutputSettings` `` with ``- Types: `Plan`, `Look`, `Backdrop`, `ShaderBackdrop`, `OutputSettings` ``.

In `## Development`, replace:

````
bun run build           # dist/
node dist/cli.js --help
```
````

with:

````
bun run build           # dist/ (tsc) and dist/editor/ (the editor page, bundled with esbuild)
node dist/cli.js --help
bun scripts/presets-sheet.ts   # regenerates docs/images/backdrop-presets.jpg after changing a preset
```
````

Replace `## License` and its body:

```
## License

[MIT](LICENSE)
```

with:

```
## License

[MIT](LICENSE). The backdrop styles were inspired by [gradflow](https://github.com/meerbahadin/gradflow) (MIT); see
[NOTICE](NOTICE).
```

- [ ] **Step 6: Run the docs tests, the whole suite, lint, typecheck and build**

Run: `bun test test/docs.test.ts && bun run test && bunx biome check . && bunx tsc --noEmit && bun run build`
Expected: PASS (5 docs tests); the full suite green; the build writes `dist/` and `dist/editor/`.

- [ ] **Step 7: Check the editor by eye**

Run: `bun run build && node dist/cli.js look edit --master <any recording> -o /tmp/look.json`
Expected: the browser opens the editor; the preview shows the recording's frame on the hero backdrop; clicking a preset thumbnail changes the backdrop; dragging Tilt Y warps the window; turning Motion on enables Play and the backdrop drifts; Save shows "Saved to /tmp/look.json" and the command exits 0. Then `node dist/cli.js plan <recording> -o /tmp/plan.json --look /tmp/look.json && node dist/cli.js render /tmp/plan.json -o /tmp/out` renders with that backdrop.

- [ ] **Step 8: Commit**

```bash
git add NOTICE scripts/presets-sheet.ts docs/images/backdrop-presets.jpg README.md package.json test/docs.test.ts
git commit -m "docs: backdrops, look editor, presets contact sheet and NOTICE crediting gradflow"
```

---

## Spec coverage

| Spec section | Where |
|---|---|
| §1 success criteria 1 (plan/render, still or animated, deterministic) | Tasks 5, 7 (round trip, determinism tests in 1–6) |
| §1 criterion 2 (seamless loops) | `describeStyle` (Tasks 1–4), Task 6 intermediate video test |
| §1 criterion 3 (editor = render code) | Task 9 (`paintBackdrop` uses `shaderField`, `fieldSize`, `applyGrain`; `windowBox` uses `sceneLayout`'s homography) |
| §1 criterion 4 (agents without a browser) | Task 10 (`looks`, `look preview`, `--look <preset>`, `--no-open`) |
| §1 criterion 5 (no runtime deps, Node ≥ 20 and Bun) | Global Constraints; Task 6 Step 6 and Task 9 (esbuild dev-only) |
| §2 styles, OKLab, seeded, periodic | Tasks 1–4 |
| §2 shared settings, grain, vignette | Tasks 1 (post), 5 (schema), 6 (full-size grain), 7 (motion grain) |
| §2 presets, `--look <backdrop preset>` | Task 5 |
| §3 look file, validation, plan.json records it | Task 5; Task 7 round trip |
| §4 rendering (reduced field, Skia upscale, still, animated, preview, determinism) | Tasks 6, 7 (rulings B2–B5) |
| §5 commands | Task 10 |
| §6 server, page, performance, save, bundling | Tasks 8, 9 |
| §7 the skill | Task 10 Step 7 |
| §8 testing | Every task; the integration colour check is Task 7; by eye: Task 10 Step 9, Task 11 Steps 4 and 7 |
| §9 out of scope | nothing planned for it |
