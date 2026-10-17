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
    say("The editor is no longer running: nothing was saved. Use Copy JSON to keep your look.", true);
  }
  save.disabled = false;
});

const beat = () =>
  fetch("/heartbeat", { method: "POST" }).catch(() =>
    say("The editor is no longer running. Use Copy JSON to keep your look.", true),
  );
const heartbeat = setInterval(beat, HEARTBEAT_MS);
beat();
// Hidden tabs throttle timers, so ping at once when the tab comes back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") beat();
});
addEventListener("pagehide", () => navigator.sendBeacon("/bye"));
addEventListener("resize", () => draw(false));
byId<HTMLElement>("out").textContent = info.out;
draw(false);
