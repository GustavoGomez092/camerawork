import { CameraworkError, parseWith } from "./errors.js";
import { type Look, LookSchema } from "./schema.js";

/** Built-in looks. Lengths are pixels at a 1920-px-wide window (ruling R1). */
export const LOOKS = {
  // Measured from the JSLab hero (ruling R2): padding 0.09, radius 18, no tilt, a gray sky-to-ground gradient.
  hero: {
    preset: "hero",
    backdrop: {
      type: "gradient",
      angle: 180,
      stops: [
        { at: 0, color: "#8f8f8f" },
        { at: 0.27, color: "#c4c4c4" },
        { at: 0.42, color: "#1a1a1a" },
        { at: 1, color: "#0e0e0e" },
      ],
    },
    padding: 0.09,
    radius: 18,
    shadow: { blur: 60, offsetY: 24, opacity: 0.55 },
    tilt: { rotateX: 0, rotateY: 0, perspective: 2400 },
  },
  flat: {
    preset: "flat",
    backdrop: { type: "none" },
    padding: 0,
    radius: 0,
    shadow: { blur: 0, offsetY: 0, opacity: 0 },
    tilt: { rotateX: 0, rotateY: 0, perspective: 2400 },
  },
} satisfies Record<string, Look>;

/** A preset by name (a fresh copy), or a look object validated against the schema. */
export function resolveLook(look: string | Look): Look {
  if (typeof look !== "string") return parseWith(LookSchema, look, "look");
  const preset = Object.hasOwn(LOOKS, look) ? (LOOKS as Record<string, Look>)[look] : undefined;
  if (!preset) throw new CameraworkError(`unknown look "${look}" (known: ${Object.keys(LOOKS).join(", ")})`);
  return structuredClone(preset);
}
