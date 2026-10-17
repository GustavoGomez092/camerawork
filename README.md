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
