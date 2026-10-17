import { STYLE_NAMES, type StyleName } from "../src/backdrops/index.js";
import type { Look } from "../src/schema.js";
import {
  addColor,
  currentColors,
  getPath,
  RANGES,
  type Range,
  removeColor,
  setPath,
  shaderFor,
  withColor,
} from "./state.js";

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
        change(setPath(current(), "backdrop.colors", withColor(currentColors(current()), i, pick.value)), true);
      });
      pick.addEventListener("change", () => change(current(), false));
      const remove = el("button", { type: "button", textContent: "×", title: "Remove", disabled: list.length <= 2 });
      remove.addEventListener("click", () => {
        change(setPath(current(), "backdrop.colors", removeColor(currentColors(current()), i)), false);
        sync(current());
      });
      colors.append(pick, remove);
    });
    const add = el("button", { type: "button", textContent: "+ colour", disabled: list.length >= 5 });
    add.addEventListener("click", () => {
      change(setPath(current(), "backdrop.colors", addColor(currentColors(current()))), false);
      sync(current());
    });
    colors.append(add);
  }

  function sync(look: Look) {
    const bd = look.backdrop;
    const shader = bd.type === "shader";
    style.value = shader ? bd.style : "";
    drawColors(currentColors(look));
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
