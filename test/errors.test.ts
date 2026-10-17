import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CameraworkError, parseWith } from "../src/errors.js";

describe("parseWith", () => {
  const schema = z.object({ width: z.number().int().positive(), name: z.string() }).strict();

  test("returns the parsed value", () => {
    expect(parseWith(schema, { width: 4, name: "a" }, "thing")).toEqual({ width: 4, name: "a" });
  });

  test("throws a CameraworkError naming the file and every bad field", () => {
    try {
      parseWith(schema, { width: -1, extra: true }, "plan.json");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CameraworkError);
      const message = (error as Error).message;
      expect(message).toStartWith("plan.json is invalid: ");
      expect(message).toContain("width:");
      expect(message).toContain("name:");
    }
  });
});
