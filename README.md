# camerawork

[![CI](https://github.com/GustavoGomez092/camerawork/actions/workflows/ci.yml/badge.svg)](https://github.com/GustavoGomez092/camerawork/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Turn a high-resolution screen recording into a guided video tour. camerawork finds where the screen changes, plans a
calm camera that zooms and pans to each change (optionally steered by cues from a capture script), and renders it with
a presentation look (backdrop, rounded corners, shadow, optional tilt) into web-ready mp4, webm and a poster image.
It is a CLI, a Node library and a Claude skill.

## What it does

1. **Detect** what changes: the master is compared frame to frame and each burst of change becomes a moment with a
   rectangle (typing, a result appearing, a panel opening). Blinking cursors and areas you mask are ignored.
2. **One focus per moment**: nearby moments that fit one frame are merged into a single shot, so a typing burst
   is one growing shot, not twenty.
3. **A calm camera**: it arrives slightly early, holds long enough to read, then pans, eases out to the full
   window, or stays put. Speed is capped, and a moment the camera cannot reach in time is skipped rather than
   chased. Loops rest wide at both ends.
4. **A presentation look**: the window sits on a backdrop with padding, rounded corners and a shadow.
5. **Encode**: mp4, webm and a poster, with a refusal to upscale so the output is always sharp.

What you get:

- `feature.mp4`, `feature.webm` and `feature.jpg` (or `.webp`) from one `plan.json`;
- `plan.json`, the editable source of truth: change a keyframe or the look and render again without re-detecting;
- a contact sheet and a debug video that show the camera's plan before you spend time rendering;
- a Claude skill that runs the loop for you, including looking at the contact sheet.

## Install

One command: it installs ffmpeg if it is missing, the camerawork engine and the Claude skill.

```bash
curl -fsSL https://raw.githubusercontent.com/GustavoGomez092/camerawork/main/skills/camerawork/install.sh | bash
```

It is safe to run again. It never installs Node for you: if Node 20+ is missing it tells you how and stops.

### As a Claude Code plugin

```
/plugin marketplace add GustavoGomez092/camerawork
/plugin install camerawork@camerawork
```

The plugin adds the skill. The first time the skill is used it checks for `camerawork` and, if it is missing, runs
the installer with `--engine-only` (ffmpeg and the engine, no second copy of the skill).

### Manual

```bash
# the engine: fetch the repository as a tarball, then install that globally
cd "$(mktemp -d)" && npm pack git+https://github.com/GustavoGomez092/camerawork.git && npm install -g ./camerawork-*.tgz

# the skill: copy it next to your other Claude skills
mkdir -p ~/.claude/skills
cp -R "$(npm root -g)/camerawork/skills/camerawork" ~/.claude/skills/camerawork
```

`npm install -g github:GustavoGomez092/camerawork` is the short form (it fetches over ssh first, so it fails on machines without GitHub keys). It builds the package on install, but some npm
versions then link the global install to a temporary checkout that npm deletes, which leaves a broken `camerawork`
command (seen with npm 11.6 and 11.21 on a local git URL). The installer therefore always packs first, as above.

Publishing to the npm registry is planned: once published, `npm install -g camerawork` will work. It is not
available yet.

### Requirements

- macOS or Linux
- Node 20 or newer
- ffmpeg and ffprobe 6 or newer on PATH (the installer installs them with `brew`, `apt-get`, `dnf` or `pacman`)

### Installer flags

Pass flags after `bash -s --` when piping: `curl -fsSL … | bash -s -- --engine-only`.

| Flag | Effect |
|---|---|
| `--engine-only` | Install ffmpeg and the engine only, not the Claude skill. |
| `--skill-only` | Copy the skill only: no ffmpeg, no engine. |
| `--project` | Put the skill in `./.claude/skills` instead of `~/.claude/skills`. |
| `--ref <git ref>` | Install this branch, tag or commit instead of `main` (env `CAMERAWORK_REF`). |
| `--no-ffmpeg` | Do not try to install ffmpeg. |
| `--upgrade` | Reinstall the engine even if `camerawork` is already on PATH. |
| `-h`, `--help` | Show the help. |

The skill is copied (never symlinked) from the installed package, found through the `camerawork` executable and then
`npm root -g`. If the package is not installed, as with `--skill-only` from a checkout or the plugin cache, the copy
comes from the skill directory next to the script. An existing symlink at the target (a dev setup) is left alone.

## For AI agents

```bash
command -v camerawork && camerawork --version        # is the engine installed?
# if not: install it (and ffmpeg). Use the copy next to the skill if you have it:
bash "<skill base directory>/install.sh" --engine-only
# otherwise:
curl -fsSL https://raw.githubusercontent.com/GustavoGomez092/camerawork/main/skills/camerawork/install.sh | bash -s -- --engine-only

camerawork plan master.mov -o plan.json --look hero --loop   # prints shots, keyframes and the effective max zoom
camerawork preview plan.json                                 # writes plan-sheet.png and plan-debug.mp4
# open plan-sheet.png and look at it: is every important moment inside the yellow box?
# if not, fix with --mask / --max-zoom / --min-hold / a cues.json, then plan and preview again
camerawork render plan.json -o out/feature                   # out/feature.mp4, .webm, .jpg
```

Output options (`--width`, `--fps`, `--formats`, `--poster`, `--max-bytes`, `--quality`, `--look`, `--loop`) belong to
`plan`; `preview` and `render` reject them (exit code 2). The skill in
[`skills/camerawork/SKILL.md`](skills/camerawork/SKILL.md) has the full workflow.

## Quick start

Record the screen at twice the width you want to publish (a 3840-px master for a 1920-px video), then:

```bash
mkdir -p out
camerawork plan master.mov -o plan.json --look hero --loop      # detect and plan
camerawork preview plan.json                                    # plan-sheet.png + plan-debug.mp4
camerawork render plan.json -o out/feature                      # out/feature.mp4, out/feature.webm, out/feature.jpg
```

`plan` prints a line such as `7 shots, 22 keyframes, max zoom 2.20 → plan.json`. The `-o` directory must already
exist. To only see what was detected: `camerawork detect master.mov -o changes.json`, and later
`camerawork plan master.mov -o plan.json --changes changes.json` to plan without detecting again.

## Reading the contact sheet

`camerawork preview plan.json` writes `plan-sheet.png`: one tile per 0.5 s of the master, six tiles per row, each
with overlays:

- **yellow box**: where the camera is looking at that moment;
- **red boxes**: shots from detection (`source: "auto"`);
- **cyan boxes**: shots from your cues (`source: "cue"`).

Shots are labelled `#1`, `#2`, … in order.

Check that every important moment (typing, a result, a panel opening) is inside the yellow box when it happens;
that nothing important is cut off at its edge; that the camera is not chasing noise such as a spinner, a clock or a
blinking cursor (mask it); and that a loop rests wide at its start and end. `plan-debug.mp4` shows the same boxes
over the moving master.

## CLI reference

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

Exit codes: 0 success, 1 a problem with your input or environment (the message says what to change), 2 a usage
error (unknown command, a flag the command does not take, a non-numeric value).

### `detect`

Finds the changes in a master and writes them to a JSON file.

| Flag | Meaning |
|---|---|
| `-o <changes.json>` | Required. The output file. |
| `--mask x,y,w,h` | Ignore this area, in master pixels. Repeatable. |

### `plan`

Detects (unless `--changes` is given), merges cues, and plans the camera. Writes `plan.json`.

| Flag | Default | Meaning |
|---|---|---|
| `-o <plan.json>` | required | Output file. |
| `--cues <file>` | none | A [cues.json](#cuesjson). |
| `--changes <file>` | detect | Use a file made by `detect` (it must come from a master of the same size). |
| `--look <name or file>` | `hero` | A look preset (`hero`, `flat`), a [backdrop preset](#backdrops) (the hero window on that backdrop), or a path ending in `.json` with a [look](#looks). |
| `--loop` | off | The video loops: it starts and ends wide, with the final move back reserved. |
| `--width N` | `1920` | Output width in pixels (even). Height follows the master's aspect ratio. |
| `--fps N` | `30` | Output frame rate. |
| `--formats a,b` | `mp4,webm` | Any of `mp4`, `webm`. |
| `--poster jpg\|webp\|none` | `jpg` | Poster image written next to the videos. |
| `--max-bytes N` | none | Fail the render if an output file is larger than N bytes. |
| `--quality medium\|high` | `medium` | Encoder quality. |
| `--max-zoom N` | `2.2` | Deepest zoom the planner may use. |
| `--min-hold N` | `1.2` | Seconds the camera stays on a shot. |
| `--mask x,y,w,h` | none | Ignore this area when detecting, in master pixels. Repeatable. |

The other planner values (below) can be set in cues.json. The plan stores the effective values.

| Planner value | Default | Meaning |
|---|---|---|
| `margin` | `0.12` | Space kept around a focus, as a fraction of its size on each side. |
| `maxZoom` | `2.2` | Deepest zoom. |
| `panZoomTolerance` | `0.3` | How much zoom difference still counts as one shot (and as a pan, not a zoom change). |
| `zoomOutGap` | `1.0` | Seconds of gap between shots needed to ease out wide in between. |
| `anticipation` | `0.35` | Seconds the camera arrives before the change. |
| `minHold` | `1.2` | Seconds the camera stays on a shot. |
| `maxPanSpeed` | `0.6` | Pan speed cap, in scene widths per second. |
| `maxZoomRate` | `1.5` | Zoom speed cap, as a zoom factor per second. |
| `idleWide` | `2.5` | Seconds of quiet before the camera drifts back to wide. |
| `shotJoinGap` | `0.6` | Moments closer than this (seconds) can join one shot. |

`plan` fails with "would upscale" only when the scene at zoom 1 is narrower than `--width` (see
[Troubleshooting](#troubleshooting)). `--max-zoom` is clamped to the scene width divided by `--width`, so a small
master caps the zoom by itself: that is why `plan` prints the effective max zoom.

### `preview`

`camerawork preview plan.json [-o prefix]` writes `<prefix>-sheet.png` and `<prefix>-debug.mp4` and prints their
paths. The prefix defaults to the plan's path without `.json` (`plan.json` gives `plan-sheet.png` and
`plan-debug.mp4`). It takes no output options.

### `render`

`camerawork render plan.json -o out/feature` writes `out/feature.mp4`, `out/feature.webm` and `out/feature.jpg`
(as the plan's formats and poster say) and prints their paths. It refuses a plan that would upscale. Progress shows
on stderr when it is a terminal. It takes no output options: change them with `plan`, or edit `plan.json`.

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

### `--version`, `--help`

`camerawork --version` prints the version. `camerawork --help` (or `-h`, or no command) prints the usage above.

## cues.json

Cues let a capture script say what matters. They win over detection inside their window. Times are seconds from the
master's first frame; rectangles are master pixels `[x, y, w, h]`.

```json
{
  "version": 1,
  "masks": [[3700, 0, 140, 40]],
  "planner": { "maxZoom": 2 },
  "cues": [
    { "t": 3.2, "rect": [1083, 26, 261, 57], "zoom": 2.0, "hold": 1.5, "label": "filter chips" },
    { "t": 8.0, "wide": true },
    { "from": 5.0, "to": 6.0, "ignore": true }
  ]
}
```

| Field | Meaning |
|---|---|
| `version` | Always `1`. |
| `masks` | Areas to ignore in detection, `[x, y, w, h]` each. |
| `planner` | Any of the planner values above, overriding the defaults (command-line flags win over this). |
| `cues` | The list below. |

Cue kinds:

- **focus**: `{ "t", "rect", "zoom"?, "hold"?, "label"? }` frames `rect` at time `t`. `zoom` (at least 1) forces a
  zoom, `hold` (seconds) forces how long it stays.
- **wide**: `{ "t", "wide": true, "label"? }` goes to the full window at `t`.
- **ignore**: `{ "from", "to", "ignore": true, "label"? }` drops detected changes in that window.

Unknown fields are rejected, so a typo is reported instead of silently ignored. From a capture script, time cues
from the moment the recording actually started, and convert element rectangles (window points) to master pixels by
multiplying by the display's backing scale.

## Looks

A look is the presentation around the window. Pick a built-in with `--look hero` or `--look flat`, or give a JSON file
with `--look my-look.json`.

- `hero`: a gray gradient backdrop, `padding` 0.09, `radius` 18, a soft shadow, no tilt.
- `flat`: the window alone: no backdrop, padding, rounding or shadow.

A custom look is a full object (all fields required except `preset`):

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
| `backdrop` | One of `{ "type": "gradient", "angle": 180, "stops": [{ "at": 0, "color": "#8f8f8f" }, …] }` (at least two stops, `at` from 0 to 1), `{ "type": "solid", "color": "#101010" }`, `{ "type": "image", "path": "bg.jpg" }`, or `{ "type": "none" }`. Colors are `#rrggbb`. An image path is stored absolute in the plan; a relative one counts from the plan file's folder. |
| `padding` | Space around the window as a fraction of the width, 0 to 0.45. |
| `radius` | Corner radius in pixels at a 1920-px-wide window. |
| `shadow` | `blur` and `offsetY` in pixels (same scale), `opacity` 0 to 1. |
| `tilt` | A fixed 3D tilt: `rotateX` and `rotateY` in degrees (-30 to 30), `perspective` in pixels. |

## Library API

The package is ESM and ships types.

```ts
import { detect, plan, preview, render, readPlan, writeJsonAtomic } from "camerawork";

const p = await plan("master.mov", {
  look: "hero",
  loop: true,
  output: { width: 1920 },
  planner: { maxZoom: 2 },
});
writeJsonAtomic("plan.json", p);

const { sheet, debug } = await preview(p, { out: "plan" });          // plan-sheet.png, plan-debug.mp4
const files = await render(readPlan("plan.json"), { out: "out/feature" }); // ["out/feature.mp4", …]
```

- `plan(masterPath, options?)` returns a `Plan`. Options: `cues`, `changes`, `look` (a name or a `Look`), `loop`,
  `output` (partial `OutputSettings`: `width`, `fps`, `formats`, `poster`, `maxBytes`, `quality`), `planner`
  (partial `PlannerParams`) and `masks`.
- `render(plan, { out, onProgress? })` writes the files and returns their paths.
- `preview(plan, { out, every?, columns?, tileWidth?, debugWidth? })` returns `{ sheet, debug }`.
- `detect(masterPath, { masks?, threshold?, analysisFps?, scale? })` returns a `ChangesFile`.
- Helpers: `readPlan`, `readCueFile`, `readChangesFile`, `writeJsonAtomic`, `resolveLook`, `LOOKS`,
  `checkSharpness`, and `CameraworkError` (thrown for problems with your input, with a message that says what to
  change).
- Types: `Plan`, `Look`, `Backdrop`, `OutputSettings`, `PlannerParams`, `Cue`, `FocusCue`, `WideCue`, `IgnoreCue`,
  `CueFile`, `Change`, `ChangesFile`, `Shot`, `Keyframe`, `View`, `Rect`, `Probe`, `PlanOptions`, `PreviewOptions`,
  `RenderOptions`, `DetectOptions`, and the matching zod schemas (`PlanSchema`, `LookSchema`, …).

## Troubleshooting

- **"would upscale"**: the scene at zoom 1 is narrower than `--width`. Lower `--width` when planning (the message
  suggests a value) or record a bigger master. Lowering `--max-zoom` does not help: it is capped by the master size
  (at most scene width / `--width`), which is why `plan` prints the effective max zoom.
- **"larger than the …-byte limit"**: the output exceeds `--max-bytes`. Plan again with a lower `--width` or `--fps`,
  or a higher `--max-bytes`.
- **The camera chases a status bar, spinner or clock**: mask it with `--mask x,y,w,h` (master pixels) or `"masks"`
  in cues.json, then plan and preview again.
- **The camera is twitchy**: raise `--min-hold`. **Text gets too big**: lower `--max-zoom`.
- **"ffmpeg" or "ffprobe" not found**: install ffmpeg 6 or newer (`brew install ffmpeg`,
  `sudo apt-get install -y ffmpeg`), or run the installer again.
- **`EACCES` from `npm install -g`**: npm cannot write to its global folder. Do not use sudo: run
  `mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global`, add `~/.npm-global/bin` to your PATH, or use
  [nvm](https://github.com/nvm-sh/nvm); then run the installer again.
- **"cannot write … the directory … does not exist"**: create the folder you pass to `-o` first.
- **`camerawork: command not found` after installing**: add the npm global bin folder (`npm prefix -g`, then
  `/bin`) to your PATH and open a new shell.

## Uninstall

```bash
npm uninstall -g camerawork
rm -rf ~/.claude/skills/camerawork        # or ./.claude/skills/camerawork for a --project install
```

For the plugin: `/plugin uninstall camerawork@camerawork`.

## Development

```bash
bun install
bun test                # needs ffmpeg and ffprobe 6+
bun run lint            # biome
bun run typecheck       # tsc --noEmit
bun run build           # dist/
node dist/cli.js --help
```

Design: [docs/superpowers/specs/2026-10-17-camerawork-design.md](docs/superpowers/specs/2026-10-17-camerawork-design.md)
(change detection by frame differencing, shot clustering and a capped, eased camera path, then ffmpeg for the scene,
Skia for the camera, ffmpeg for the encode).

## License

[MIT](LICENSE)
