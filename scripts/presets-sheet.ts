// Renders the README's contact sheet of every backdrop preset, each on a plain window mock.
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
