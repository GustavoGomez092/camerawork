# camerawork: guided video tours from screen recordings

Date: 2026-10-17 · Status: approved design (brainstorming), awaiting the implementation plan

## 1. Purpose

Product-site videos made from plain screen recordings show a whole window, static, at a size where nothing is
readable and nothing points at what changed. A good demo video moves a camera: it zooms into the code being typed,
pushes into a result when it appears, pans to the next thing that matters, and pulls back out.

camerawork turns a high-resolution screen recording (the **master**) into that kind of video, automatically:

- it **detects** where and when the screen changes;
- it **plans** a calm camera path from those changes, optionally steered by **cues** a capture script writes;
- it **renders** the result with a presentation **look** (backdrop, padding, rounded corners, shadow, fixed 3D tilt)
  and encodes web-ready files.

It is reusable for any app. Its first user is the JSLab marketing site (js-lab.app), whose four section loops are
today flat 2560 px recordings of the whole window.

### Success criteria

1. Given only a master, `plan` + `render` produce a video whose camera frames each meaningful change (typing,
   a result appearing, a panel opening) and ignores noise (cursor blink, spinners, masked areas).
2. Script cues, when present, override detection inside their window.
3. Output is sharp: the engine refuses to upscale (see §6.3).
4. The four JSLab section loops are re-rendered with the `hero` look and read clearly at the size the site shows
   them.
5. A Claude skill lets an agent run the whole workflow, including checking the plan visually before rendering.

### Decisions made during brainstorming

| Decision | Choice |
|---|---|
| Scope | Reusable public tool; JSLab is the first user |
| Camera cues | Automatic detection by default; script cues add to or override it |
| Look | Hero-style presets (backdrop, padding, radius, shadow, tilt), chosen per video |
| Home | Public MIT repo `github.com/GustavoGomez092/camerawork`, npm package `camerawork` |
| Renderer | Own frame compositor: ffmpeg + Skia (`@napi-rs/canvas`), no browser |

### Prior art considered

- **openvid** (openvid.dev): browser editor with zoom fragments, zoom movements and 3D mockups. Not usable: its
  license is PolyForm Noncommercial 1.0.0 (JSLab is a paid product), and it has no CLI or API; zooms follow the
  cursor or are placed by hand. Ideas only, no code.
- **OpenScreen, Screenize, Recordly, screen-demo, FollowCursor**: recorder apps that zoom on clicks and cursor
  movement. Scripted keyboard-driven captures have almost no clicks or cursor motion, and these need a human in a
  GUI. FollowCursor's idea of chaining nearby activity into one zoomed pan is adopted (§5.3).
- **demowright, playwright-recast**: scripted zoom-to-selector, but tied to Playwright/Chromium; JSLab is a native
  WebKit (Electrobun) window.
- **Remotion**: not MIT (companies of 4+ need a paid license), which a public MIT tool would push onto its users.
- **Revideo / Motion Canvas**: MIT with a camera node, but Revideo's roadmap now follows a commercial product and
  Motion Canvas's stable line is old; automatic cue tracks would fight their scene model.

### Non-goals

Re-rendering the JSLab hero video, voiceover, captions, music, a GUI editor, animated tilt.

## 2. Packaging and dependencies

- TypeScript, published to npm as `camerawork`; runs on Node ≥ 20 and Bun ≥ 1.4. Library API plus a CLI (`bin`).
- Runtime dependencies: `@napi-rs/canvas` (Skia, MIT) and `zod` (schemas). Nothing else at runtime.
- **ffmpeg and ffprobe ≥ 6 must be on `PATH`**; they are not bundled (keeps the package MIT and small). The CLI
  checks for them first and says how to install them if missing.
- License: MIT. CI: GitHub Actions, macOS and Linux.

## 3. Pipeline

```
master.mov ──► detect ──► changes.json ─┐
                                        ├─► plan ──► plan.json ──► preview (contact sheet + debug video)
 cues.json (optional, from scripts) ────┘                    └──► render ──► out.mp4 / out.webm / poster
```

Each stage is a library function and a CLI command; `plan` runs `detect` itself unless given `--changes`.

```
camerawork detect master.mov -o changes.json [--mask x,y,w,h ...]
camerawork plan master.mov [--cues cues.json] [--changes changes.json] [--look hero] [--loop] -o plan.json
camerawork preview plan.json            # → plan-sheet.png, plan-debug.mp4
camerawork render plan.json --width 2560 --fps 30 --formats mp4,webm --poster [--max-bytes N] -o <out-prefix>
```

`plan.json` is the source of truth for rendering: it records the master path and its probe, every keyframe, the
look, the output settings and every planner parameter used. Editing it and re-running `render` never re-detects.

All coordinates are in **master pixels**, origin top-left. Times are seconds from the master's first frame.

## 4. Detection (`detect`)

1. ffmpeg decodes the master to grayscale at 1/8 of its size and 15 fps (`-vf fps=15,scale=iw/8:-1,format=gray`,
   raw frames on a pipe).
2. Each frame is differenced against the previous one; pixels whose change exceeds a threshold (default 12/255)
   form a mask.
3. The mask is grouped into connected regions; regions closer than 2 % of the frame width are merged; regions
   smaller than a minimum area (default 0.02 % of the frame) are dropped.
4. **Blink filter:** a region that reappears in the same place (IoU ≥ 0.6) at a steady period between 0.3 s and
   1.5 s, at least three times, is a blink (text cursor, spinner) and is dropped.
5. **Masks:** user rectangles (`--mask`, or `masks` in cues) are zeroed before step 3.
6. A change covering more than 60 % of the frame is recorded as `fullFrame: true` (a cut or theme switch) and means
   "go wide".

Output `changes.json`: `{ version: 1, master: {path, width, height, fps, duration}, changes: [{ t, rect: [x, y, w,
h], strength, fullFrame? }] }` with `strength` = changed-pixel fraction of the region.

## 5. Cues and planning

### 5.1 Cue file

```json
{ "version": 1,
  "masks": [[3700, 0, 140, 40]],
  "cues": [
    { "t": 3.2, "rect": [1083, 26, 261, 57], "zoom": 2.0, "hold": 1.5, "label": "filter chips" },
    { "t": 8.0, "wide": true },
    { "from": 5.0, "to": 6.0, "ignore": true } ] }
```

- A `rect` cue focuses that rectangle from `t` for `hold` seconds (default: until the next shot). `zoom` overrides
  the computed zoom (still clamped, §5.3).
- A `wide` cue returns to the full scene at `t`.
- An `ignore` range drops all detected changes inside it.
- Inside a cue's window, detected changes are discarded: the cue wins.
- Validation: unknown keys, `t` outside the master's duration, `from ≥ to`, or a `rect` outside the master are
  errors with the cue's index in the message.

### 5.2 Shots

Changes (detected, minus ignored, plus cues) are clustered into **shots**: consecutive changes join the current
shot when they start within 0.6 s of its last change and their union still fits the maximum-zoom-out frame. A
typing burst therefore becomes one shot whose target grows with the text. Each shot has `start`, `end` and a target
rectangle (the union of its changes).

### 5.3 Framing and moves

- **Framing:** the camera view for a shot is the smallest rectangle with the output's aspect ratio containing the
  target plus a 12 % margin. Zoom = scene width / view width, clamped to `[1, maxZoom]` (default `maxZoom` 2.2). If
  the target does not fit at zoom 1 the shot is wide.
- **Pan vs zoom out:** when the next shot's zoom is within ±30 % of the current one, the camera pans directly (the
  hero's chat-box → diff move). Otherwise, if the gap between shots is ≥ 1.0 s, it eases out toward wide and back
  in; if the gap is shorter it zooms directly to the new framing.
- **Anticipation:** the camera reaches each shot's framing 0.35 s before the shot starts (planning is offline).
- **Calm:** each shot is held ≥ 1.2 s; pan speed is capped at 0.6 scene-widths per second and zoom rate at 1.5×
  per second (moves lengthen to respect the caps); every move uses ease-in-out (cubic). After 2.5 s without
  changes the camera drifts back to wide.
- **Loops:** `--loop` forces the first and last keyframe to the wide framing so a looping site video restarts
  cleanly.
- Parameters above are defaults, settable by flags or a `planner` object in the cue file, and written into
  `plan.json`. Their names: `margin` (0.12), `maxZoom` (2.2), `panZoomTolerance` (0.3), `zoomOutGap` (1.0 s),
  `anticipation` (0.35 s), `minHold` (1.2 s), `maxPanSpeed` (0.6), `maxZoomRate` (1.5), `idleWide` (2.5 s),
  `shotJoinGap` (0.6 s).

### 5.4 Plan file

`{ version: 1, master: {...probe}, output: { width, fps, formats, poster, maxBytes }, look: {...}, planner: {...},
keyframes: [{ t, cx, cy, zoom, ease }] }` validated by a zod schema on read. `cx, cy` are the view center in scene
pixels (§6.1).

## 6. Rendering

### 6.1 Look

```json
"look": { "preset": "hero",
  "backdrop": { "type": "gradient", "stops": ["#2b2f36", "#0d0f12"], "angle": 160 },
  "padding": 0.08, "radius": 18, "shadow": { "blur": 60, "offsetY": 24, "opacity": 0.55 },
  "tilt": { "rotateX": 4, "rotateY": -6, "perspective": 2400 } }
```

- Presets: `hero` (values measured from the JSLab hero video's frames during implementation; the numbers above are
  placeholders to be replaced by the measured ones) and `flat` (no backdrop, padding 0, radius 0, no tilt: the
  window fills the scene).
- `backdrop.type` is `gradient`, `solid` or `image` (`path`).
- The **scene** is the backdrop at the master's size and output aspect ratio, with the window (the master) scaled
  to fit inside `padding`, rounded, shadowed and tilted. Camera zoom 1 shows the whole scene.

### 6.2 Three streaming processes

1. **Scene (ffmpeg):** decodes the master; applies the rounded-corner alpha mask (`alphamerge`); applies the fixed
   tilt (`perspective` filter, cubic interpolation, corner points computed from `tilt`); overlays the shadow and the
   window on the backdrop. The backdrop, mask and shadow images are drawn once by Skia before the run. Emits raw
   RGBA scene frames at the output fps on a pipe.
2. **Camera (Node, Skia):** for each frame, interpolates the keyframes to `(cx, cy, zoom)`, draws the scene frame
   onto an output-size canvas with that transform (sub-pixel, high-quality resampling), and writes raw RGBA to the
   encoder's pipe. Backpressure is honoured; nothing is buffered beyond a frame or two.
3. **Encode (ffmpeg):** mp4 = `libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart`; webm =
   `libsvtav1 -crf 32 -preset 6`, falling back to `libvpx-vp9 -crf 32 -b:v 0 -row-mt 1` when SVT-AV1 is absent;
   optional poster (first frame, JPEG/WebP). Several formats are encoded from one camera pass (tee to several
   encoders).

### 6.3 Guards

- **Sharpness:** before rendering, `master.width / (outputWidth × maxZoomInPlan) ≥ 1` must hold after the
  padding/fit scale; otherwise render stops and names the fix (lower `maxZoom`, lower `--width`, or a bigger
  master). No silent upscaling.
- **Size:** `--max-bytes` fails the render (and deletes the oversize output) when a file exceeds it.
- **Atomic output:** files are written to `<name>.tmp-<pid>` and renamed only on success.
- **Errors** that stop with an actionable message: ffmpeg/ffprobe missing or too old, unreadable master, invalid
  cue or plan file (zod path + reason), cue out of range, sharpness, size.

Expected speed: 1–3× the video's duration for a 4K master to a 2560 px output; the implementation measures it.

## 7. Preview

- `plan-sheet.png`: one tile per 0.5 s (configurable), each the scene frame downscaled with the camera view drawn as
  a rectangle and the time printed; shots are numbered.
- `plan-debug.mp4`: a 960 px wide render of the full scene with the camera rectangle and the detected change boxes
  drawn on, at the output fps.
- Both are for people and agents to check a plan before the slow full render.

## 8. The skill

`skills/camerawork/SKILL.md` in the repo; the README explains linking it into `~/.claude/skills/`. It covers:

- when to use it (turning a recording into a guided video, re-rendering a site video);
- the workflow: get a high-resolution master → `plan` → `preview` → **read the contact sheet** and check that every
  important moment is framed and nothing is cut off → fix with cues or masks → `render` → check the poster and a
  few output frames;
- writing cues from a capture script;
- common fixes ("camera chases a spinner" → mask it; "too twitchy" → raise `minHold`; "too zoomed" → lower
  `maxZoom`; "misses the important part" → add a `rect` cue).

## 9. JSLab integration (first user)

In the JSLab app repo (`packages/e2e` capture pipeline, `bun run site:captures`):

- A test-only E2E bridge request `rect(selector)` returns an element's bounding rectangle in window points; it exists
  only when the harness runs the app.
- Scenes may call `ctx.cue({ selector, zoom?, hold?, label })` and `ctx.wide()`. Each is timestamped from the
  recording's start, converted to master pixels using the known window frame and backing scale, and written to
  `masters/<name>.cues.json`.
- Loops go through camerawork (`plan --look hero --loop`, then `render --width 2560 --formats mp4,webm --poster`)
  instead of the flat encode, keeping today's output names (`public/site/<name>-loop.{mp4,webm,jpg}`) and size
  limits.
- The four section loops (ai, errors, palette, react) are re-captured and re-rendered; cues are added only where
  the automatic plan frames the wrong thing, judged from each contact sheet.
- The website needs no code change; it receives new files under the same names.

## 10. Testing

- **Unit:** detection on synthetic frames with known moving boxes; the blink filter; clustering into shots;
  framing and clamping; pan vs zoom-out; anticipation; minimum hold; speed and zoom-rate caps; loop endings; easing
  and keyframe interpolation; ffmpeg argument builders; cue and plan schemas (valid and each invalid case).
- **End to end:** ffmpeg generates a small test video (a coloured box jumping between known positions on a plain
  background). The full pipeline runs on it; the test asserts the output's dimensions and duration, and that the
  box's centroid in the output lies near the frame center while the camera holds on it.
- **CI:** GitHub Actions on macOS and Linux with ffmpeg installed.
- **JSLab:** unit tests for the cue writer and the coordinate conversion in `packages/e2e`; the re-rendered loops
  are checked by eye from their contact sheets and by the site's existing media tests.
