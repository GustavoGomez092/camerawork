---
name: camerawork
description: Use when turning a screen recording into a guided product video (zoom and pan to what changes, on a backdrop with a rounded window), or re-rendering a site's demo videos. Runs the camerawork CLI, checks the plan visually, and fixes it with cues or masks.
---

# camerawork: guided video tours from screen recordings

camerawork finds where a recording changes, plans a calm camera that zooms and pans to each change, and renders it
with a presentation look.

## Setup

Before first use, check the engine:

```bash
command -v camerawork && camerawork --version
```

If it is missing, run the installer that ships next to this skill (the skill loader shows this skill's base
directory):

```bash
bash "<this skill's base directory>/install.sh" --engine-only
```

If that file is not there, fetch it:

```bash
curl -fsSL https://raw.githubusercontent.com/GustavoGomez092/camerawork/main/skills/camerawork/install.sh | bash -s -- --engine-only
```

The same script installs ffmpeg and ffprobe 6+ when they are missing (brew, apt-get, dnf or pacman; it announces
sudo first). It needs Node 20+ and exits with instructions if that is missing; ask the user before installing
Node yourself. `--no-ffmpeg` skips ffmpeg, `--upgrade` reinstalls the engine.

## Workflow

1. **Get a master.** A high-resolution recording, ideally twice the output width (a 3840-px master for a 1920-px
   video); deeper zooms need more pixels. Scripted captures are best; hand recordings work too.
2. **Choose a look** (see Looks below), then **plan.** `camerawork plan master.mov -o plan.json --look hero --loop` (add `--cues cues.json` if the capture
   wrote one; `--loop` for website loops). It prints the shot count and the effective max zoom. All output options
   (`--width`, `--fps`, `--formats`, `--poster`, `--max-bytes`, `--quality`, `--look`, `--loop`) belong to `plan`:
   `preview` and `render` reject them with exit code 2.
3. **Preview.** `camerawork preview plan.json` writes `plan-sheet.png` (the contact sheet: one tile per 0.5 s;
   yellow = camera, red = detected change, cyan = cue) and `plan-debug.mp4`. `-o <prefix>` changes the names
   (`<prefix>-sheet.png`, `<prefix>-debug.mp4`).
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

Before planning, ask the user which they want: the default `hero` look, a preset, or a look customised in the editor.

- **Default:** `--look hero` (gray gradient, 9 % padding, rounded corners, shadow). `--look flat` is the window alone.
- **A preset:** `camerawork looks` lists the look and backdrop presets. `hero` is in both lists: the look wins the
  name, so `--look hero` is the full hero look. Any backdrop preset works as a look: `--look ultraviolet` is the hero
  window on the `ultraviolet` backdrop. Pick 2–3 that suit the product, render a still of each on the user's
  recording, open the PNGs and look at them, show them to the user and let them choose:

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
  the page was closed without saving or the editor timed out (nothing written). If the user abandons the editor, stop it with SIGTERM
  (`kill <pid>`): a background job in a non-interactive shell ignores SIGINT. It also ends by itself 120 s after the
  page stops pinging, or 15 minutes after start if no page connects. Then `camerawork plan master.mov -o plan.json --look
  <dir>/look.json`.

A look file is a full object with `backdrop`, `padding`, `radius`, `shadow` and `tilt`. `backdrop` can be a gradient,
a solid colour, `{ "type": "image", "path": "bg.jpg" }` (relative to the look file, or to the plan file inside plan.json),
or a procedural `{ "type": "shader", "style": "silk", "colors": [...], "motion": { "enabled": true, "speed": 0.3 } }`
(styles: silk, waves, aurora, mesh, stripes, ripple, linear, radial, conic). Motion makes the backdrop loop seamlessly over the
video; it costs render time (roughly 20–45 ms per frame on 8 cores).

## Errors worth knowing

- "would upscale": the scene at zoom 1 is narrower than `--width` → lower `--width` (the message suggests a value) or
  record a bigger master. `--max-zoom` does not fix it: it is capped by the master size, which is why `plan` prints
  the effective max zoom.
- "larger than the …-byte limit": plan again with a lower `--width` or `--fps`, or a higher `--max-bytes`.
- `camerawork: command not found` or ffmpeg missing: run the Setup step above.
- `camerawork detect master.mov -o changes.json` writes just the detected changes; pass them to `plan` with
  `--changes changes.json` to re-plan without re-detecting.
