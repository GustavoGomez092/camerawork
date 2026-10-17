import { describe, expect, test } from "bun:test";
import { STYLE_NAMES, STYLES, shaderColors, shaderField, styleParams } from "../src/backdrops/index.js";
import { BACKDROPS } from "../src/backdrops/presets.js";
import { CameraworkError, parseWith } from "../src/errors.js";
import { LOOK_DESCRIPTIONS, LOOKS, resolveLook } from "../src/looks.js";
import { BackdropSchema, LookSchema, type ShaderBackdrop } from "../src/schema.js";
import { mad } from "./style-helpers.js";

const shader = (more: Record<string, unknown> = {}): ShaderBackdrop =>
  parseWith(BackdropSchema, { type: "shader", style: "silk", ...more }, "backdrop") as ShaderBackdrop;

describe("style registry", () => {
  test("has every style named in the schema", () => {
    expect(Object.keys(STYLES).sort()).toEqual([...STYLE_NAMES].sort());
  });

  test("every style looks different from every other with the same palette", () => {
    const colors = ["#101828", "#7b2bff", "#ff2bd6", "#fde68a"];
    const fields = STYLE_NAMES.map((style) => shaderField(shader({ style, colors, grain: 0 }), 160, 90, 0));
    for (let i = 0; i < fields.length; i++)
      for (let j = i + 1; j < fields.length; j++)
        expect(mad(fields[i] as Uint8ClampedArray, fields[j] as Uint8ClampedArray)).toBeGreaterThan(4);
  });

  test("styleParams: style palette by default, speed 0 without motion, an unsigned seed, the field's extent", () => {
    const bd = shader({ seed: -1 });
    expect(shaderColors(bd)).toEqual(STYLES.silk.colors);
    const p = styleParams(bd, 200, 100);
    expect(p.lab).toHaveLength(3);
    expect(p.speed).toBe(0);
    expect(p.seed).toBe(4294967295);
    expect([p.uMax, p.vMax]).toEqual([2, 1]);
    expect(styleParams(shader({ motion: { enabled: true, speed: 0.7 } }), 100, 100).speed).toBe(0.7);
  });

  test("shaderField applies the vignette and is deterministic", () => {
    const plain = shaderField(shader({ vignette: 0 }), 160, 90, 0);
    const dark = shaderField(shader({ vignette: 1 }), 160, 90, 0);
    expect(dark[0] as number).toBeLessThan(plain[0] as number);
    expect(Buffer.from(plain).equals(Buffer.from(shaderField(shader({ vignette: 0 }), 160, 90, 0)))).toBe(true);
  });
});

describe("shader backdrops in the look file", () => {
  test("defaults follow the spec", () => {
    const bd = shader();
    expect(bd).toEqual({
      type: "shader",
      style: "silk",
      angle: 45,
      scale: 1,
      distortion: 0.3,
      seed: 1,
      grain: 0.04,
      vignette: 0,
      motion: { enabled: false, speed: 0.3 },
    });
  });

  test("invalid settings are CameraworkErrors naming the field", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ style: "plaid" }, "backdrop.style"],
      [{ colors: ["#000000"] }, "backdrop.colors"],
      [{ colors: ["#000000", "#111111", "#222222", "#333333", "#444444", "#555555"] }, "backdrop.colors"],
      [{ colors: ["#000000", "red"] }, "backdrop.colors.1"],
      [{ angle: 400 }, "backdrop.angle"],
      [{ scale: 0.1 }, "backdrop.scale"],
      [{ distortion: 2 }, "backdrop.distortion"],
      [{ seed: 1.5 }, "backdrop.seed"],
      [{ grain: 0.5 }, "backdrop.grain"],
      [{ vignette: -1 }, "backdrop.vignette"],
      [{ motion: { enabled: true, speed: 3 } }, "backdrop.motion.speed"],
      [{ sparkle: true }, "backdrop"],
    ];
    for (const [more, field] of cases) {
      const look = { ...LOOKS.hero, backdrop: { type: "shader", style: "silk", ...more } };
      expect(() => resolveLook(look as never)).toThrow(CameraworkError);
      expect(() => resolveLook(look as never)).toThrow(`${field}:`);
    }
  });

  test("a look file without colours gets its style's palette", () => {
    const look = resolveLook({ ...LOOKS.hero, backdrop: { type: "shader", style: "waves" } } as never);
    expect(look.backdrop).toMatchObject({ type: "shader", style: "waves", colors: STYLES.waves.colors });
  });
});

describe("backdrop presets", () => {
  test("every preset is a valid backdrop with a description", () => {
    expect(Object.keys(BACKDROPS).length).toBeGreaterThanOrEqual(16);
    for (const [name, preset] of Object.entries(BACKDROPS)) {
      expect(BackdropSchema.safeParse(preset.backdrop).success).toBe(true);
      expect(preset.description).toMatch(/^[a-z]+: /);
      expect(LookSchema.safeParse(resolveLook(name)).success).toBe(true);
    }
  });

  test("the spec's presets exist and every style has at least one", () => {
    for (const name of [
      "ultraviolet",
      "glacier",
      "aurora",
      "dusk",
      "midnight",
      "petal",
      "ripple-sea",
      "ember",
      "solar",
      "raspberry",
      "frost",
      "chrome",
      "graphite",
      "hero",
      "solid",
      "none",
    ])
      expect(Object.hasOwn(BACKDROPS, name)).toBe(true);
    const styles = new Set(
      Object.values(BACKDROPS).flatMap((p) => (p.backdrop.type === "shader" ? [p.backdrop.style] : [])),
    );
    expect([...styles].sort()).toEqual([...STYLE_NAMES].sort());
  });

  test("--look <backdrop preset> is the hero window on that backdrop", () => {
    const look = resolveLook("ultraviolet");
    expect(look.preset).toBe("ultraviolet");
    expect(look.backdrop).toEqual(BACKDROPS.ultraviolet?.backdrop as ShaderBackdrop);
    expect({ ...look, preset: "hero", backdrop: LOOKS.hero.backdrop }).toEqual(LOOKS.hero);
    look.padding = 0.3;
    expect(resolveLook("ultraviolet").padding).toBe(0.09);
  });

  test("look presets win over backdrop presets of the same name, and both have descriptions", () => {
    expect(resolveLook("hero")).toEqual(LOOKS.hero);
    expect(Object.keys(LOOK_DESCRIPTIONS)).toEqual(Object.keys(LOOKS));
  });
});
