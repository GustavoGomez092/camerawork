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
