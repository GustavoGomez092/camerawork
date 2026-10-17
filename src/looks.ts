import { shaderColors } from "./backdrops/index.js";
import { BACKDROPS, type BackdropPreset, FLAT_WINDOW, HERO_BACKDROP, HERO_WINDOW } from "./backdrops/presets.js";
import { CameraworkError, parseWith } from "./errors.js";
import { type Look, LookSchema } from "./schema.js";

/** Built-in looks. Lengths are pixels at a 1920-px-wide window (ruling R1). */
export const LOOKS = {
  // Measured from the JSLab hero (ruling R2): padding 0.09, radius 18, no tilt, a gray sky-to-ground gradient.
  hero: {
    preset: "hero",
    backdrop: HERO_BACKDROP,
    ...structuredClone(HERO_WINDOW),
  },
  flat: {
    preset: "flat",
    backdrop: { type: "none" },
    ...structuredClone(FLAT_WINDOW),
  },
} satisfies Record<string, Look>;

/** One line per built-in look, for `camerawork looks`. */
export const LOOK_DESCRIPTIONS: Record<keyof typeof LOOKS, string> = {
  hero: "gray gradient backdrop, 9 % padding, rounded corners, soft shadow",
  flat: "the window alone: no backdrop, padding, rounding or shadow",
};

/** Fills in the palette a shader backdrop left out, so a plan records the backdrop in full (spec: backdrops §3). */
function complete(look: Look): Look {
  const bd = look.backdrop;
  return bd.type === "shader" && !bd.colors ? { ...look, backdrop: { ...bd, colors: [...shaderColors(bd)] } } : look;
}

/**
 * A look preset by name (a fresh copy); a backdrop preset by name, which is the hero window on that backdrop; or a
 * look object, validated against the schema.
 */
export function resolveLook(look: string | Look): Look {
  if (typeof look !== "string") return complete(parseWith(LookSchema, look, "look"));
  if (Object.hasOwn(LOOKS, look)) return structuredClone((LOOKS as Record<string, Look>)[look] as Look);
  if (Object.hasOwn(BACKDROPS, look))
    return {
      ...structuredClone(LOOKS.hero),
      preset: look,
      backdrop: structuredClone((BACKDROPS[look] as BackdropPreset).backdrop),
    };
  throw new CameraworkError(
    `unknown look "${look}" (looks: ${Object.keys(LOOKS).join(", ")}; backdrops: ${Object.keys(BACKDROPS).join(", ")}). ` +
      "Run camerawork looks to see them, or pass a look .json file.",
  );
}
