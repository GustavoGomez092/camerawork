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
