# camerawork backdrops: shader backgrounds and a look editor

Date: 2026-10-17 · Status: approved design (brainstorming), awaiting the implementation plan
Builds on: `2026-10-17-camerawork-design.md` (the engine). Inspiration: MagicPattern's shader background generator
(look and feel only) and gradflow (github.com/meerbahadin/gradflow, MIT, credited in `NOTICE`).

## 1. Purpose

camerawork's backdrop today is a flat gradient, a solid colour or an image. Product videos look far better on rich,
designed backgrounds: silky light bands, glowing ribbons, mesh gradients, film grain. This adds:

- a set of **procedural background styles** with **presets**, usable from the look file and the CLI;
- optional **motion**: an animated background that loops seamlessly behind the window;
- a **local web editor** (`camerawork look edit`) that customises the whole look on a real frame of the user's
  recording and saves a look file;
- agent-friendly commands to list presets and preview a look as a still.

### Success criteria

1. A look with `backdrop.type = "shader"` renders through `plan` and `render` exactly like other looks, still or
   animated, deterministically (same look file → same pixels).
2. Animated backgrounds loop seamlessly over the video's length (first and last frames nearly identical).
3. The editor preview and the final render come from the same background code, so what the user sees is what they
   get (within preview scaling).
4. An agent with no browser can list presets, preview a look as a PNG and use any preset by name.
5. No new runtime dependencies; the published package stays small; Node ≥ 20 and Bun still work.

### Decisions made during brainstorming

| Decision | Choice |
|---|---|
| Motion | Both still and animated; still by default, motion is a per-look toggle with a speed |
| Renderer | One TypeScript source per style, rendered on the CPU (Node and the browser editor run the same code) |
| Editor | Full look (background + window padding, radius, shadow, tilt), previewed on a real frame of the master |

## 2. Background styles (`src/backdrops/`)

Each style is a pure function `shade(u, v, t, p): [r, g, b]` (0–1 floats):
- `u, v` are aspect-corrected coordinates (the short side spans 0–1, so patterns never stretch);
- `t` is loop time in `[0, 1)`, `0` for stills;
- `p` holds the resolved settings.

Styles must be periodic in `t` (sin/cos of `2πt·k` for integer `k`) so a loop is seamless. Colours are mixed in
**OKLab**. No `Math.random`: all randomness comes from a seeded hash of `seed` and coordinates.

| Style | Look |
|---|---|
| `silk` | soft diagonal bands of light with sheen, like folded fabric |
| `waves` | layered horizontal flowing waves |
| `aurora` | wide glowing ribbons over a dark base |
| `mesh` | 3–5 soft colour blobs blended (positions from `seed`) |
| `stripes` | crisp diagonal bands with soft edges and depth shading |
| `ripple` | zig-zag interference ripples |
| `linear`, `radial`, `conic` | classic gradients |

Shared settings (all styles):

| Setting | Range | Default |
|---|---|---|
| `colors` | 2–5 `#rrggbb` | style-specific |
| `angle` | 0–360° | 45 |
| `scale` | 0.2–5 | 1 |
| `distortion` | 0–1 | 0.3 |
| `seed` | integer | 1 |
| `grain` | 0–0.3 | 0.04 |
| `vignette` | 0–1 | 0 |
| `motion` | `{ enabled: boolean, speed: 0.05–2 cycles per loop }` | `{ enabled: false, speed: 0.3 }` |

Grain is a post-effect added at full resolution (crisp), seeded; it is static for stills and re-seeded per frame for
animated backgrounds. Vignette darkens the edges radially.

### Presets

About 16 named presets with our own names and palettes, for example: `ultraviolet` (silk), `glacier` (silk),
`aurora`, `dusk` (stripes), `midnight` (stripes), `petal` (mesh), `ripple-sea` (ripple), `ember` (stripes), `solar`
(waves), `raspberry` (silk), `frost` (silk), `chrome` (silk), `graphite` (stripes), plus the existing gradient `hero`
and plain `solid`/`none`. A preset is a complete `backdrop` object. Backdrop presets combine with the window settings
of a look preset (`hero` padding/radius/shadow) when used by name: `--look ultraviolet` = the `hero` look with the
`ultraviolet` backdrop.

## 3. Look file

A new backdrop variant joins `gradient`, `solid`, `image`, `none`:

```json
"backdrop": { "type": "shader", "style": "silk",
  "colors": ["#1a0b3d", "#ff2bd6", "#7b2bff"], "angle": 62, "scale": 1.0,
  "distortion": 0.4, "seed": 7, "grain": 0.06, "vignette": 0.2,
  "motion": { "enabled": false, "speed": 0.3 } }
```

Validated by zod like the rest of the look; unknown styles and out-of-range values are `CameraworkError`s naming the
field. `plan.json` records the backdrop in full, so `render` reproduces it.

## 4. Rendering

- **Resolution:** the background is computed at a reduced size with the scene's aspect ratio (≤ 1280 px on the long
  side), upscaled to the scene size with Skia high-quality resampling, then grain and vignette are applied at full
  resolution. A still takes about 1–2 s for a 4K-master scene (measured in the plan).
- **Still:** written as `backdrop.png`, used as today (looped image input at the output fps).
- **Animated:** frames rendered at the output fps with `t = frame / frameCount` over the master's duration, encoded
  once into a high-quality intermediate video in the render's work directory, and used as the scene graph's backdrop
  input instead of the looped image. Expected cost 30–60 ms per frame at the reduced size (measured in the plan).
- **Preview and contact sheet** use the same backdrop (animated backdrops animate in the debug video).
- Determinism: identical inputs give identical pixels (tested).

## 5. Commands

- `camerawork looks` — lists look presets and backdrop presets with a one-line description each.
- `camerawork look preview <preset|look.json> [--master video.mov] [--at seconds] -o look.png` — renders one composed
  still (backdrop + window frame from the master at `--at`, or a neutral placeholder window) for people and agents to
  inspect.
- `camerawork look edit [--master video.mov] [--look <preset|look.json>] -o my-look.json [--port N] [--no-open]` — the
  editor (§6).
- `plan --look` accepts backdrop preset names (combined with the `hero` window settings) as well as look presets and
  look files.

## 6. The editor

- **Server:** `node:http`, bound to **127.0.0.1 only**, random port unless `--port`. It opens the browser (macOS
  `open`, Linux `xdg-open`) unless `--no-open`, and always prints the URL. It serves the editor page, the bundled
  script, frames of the master (`GET /frame?t=…`, extracted with ffmpeg and cached), and the starting look.
- **Page** (single page, no framework, dark theme):
  - **Left:** a large preview of the composed scene: the backdrop, the window (a real frame of the master, chosen with
    a time slider, or a neutral placeholder without `--master`), rounded corners, shadow and an approximate tilt
    (CSS 3D transform). A Play toggle animates motion backgrounds.
  - **Right:** a collapsible presets grid of live thumbnails, then the controls: style, 2–5 colour pickers (add and
    remove), angle, scale, distortion, seed (with a shuffle button), grain, vignette, motion on/off and speed;
    window padding, corner radius, shadow blur/offset/opacity, tilt X/Y.
  - **Top bar:** Save, Reset, Copy JSON.
- **Performance:** the preview renders the backdrop at a reduced size while a control is being dragged, and refines
  to full preview size when the user stops.
- **Save:** posts the look; the server validates it with the same schema (errors shown on the page), writes `-o`
  atomically, shows "Saved", and the command exits 0. Closing the tab without saving ends the command after an idle
  timeout (heartbeat from the page) with exit 1 and nothing written.
- **Bundling:** the page's TypeScript (which imports `src/backdrops/` and the layout math from `src/geometry.ts`) is
  bundled at build time with esbuild (dev dependency) into `dist/editor/`; the package ships the built files.

## 7. The skill

Before planning, the skill asks the user: use the default `hero` look, pick a preset, or customise in the editor.
- Preset: show `look preview` stills of 2–3 suggestions and let the user choose.
- Customise: run `camerawork look edit --master <master> -o <dir>/look.json`, tell the user the URL, wait for it to
  exit, then `plan --look <dir>/look.json`.

## 8. Testing

- **Styles:** deterministic (same settings → same pixels); colours stay in range; every preset validates; each style
  differs visibly from the others (not a constant image).
- **Motion:** first and last frames of an animated background are nearly identical (seamless loop).
- **Look file:** a `shader` backdrop round-trips through plan and render; the scene graph uses the video input for
  motion and the image input for stills; invalid backdrops give readable errors.
- **Commands:** `looks` lists everything; `look preview` writes a PNG of the scene size or a requested width.
- **Server:** binds 127.0.0.1; serves the page and a frame; rejects an invalid look with a readable error; writes the
  file atomically on a valid save and exits; exits without writing after the idle timeout.
- **Integration:** a render with a still shader background on a synthetic master has the expected colours at the
  scene corners.
- **By eye:** the controller opens the editor in a browser and inspects it, and a contact sheet of all presets goes
  into the README.

## 9. Out of scope

Exporting backgrounds as standalone wallpapers (beyond `look preview`), GPU acceleration, user-uploaded shader code,
audio-reactive or cursor-reactive backgrounds.
