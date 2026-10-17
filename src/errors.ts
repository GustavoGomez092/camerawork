import type { z } from "zod";

/** An error meant for the person running camerawork: its message says what to change. */
export class CameraworkError extends Error {
  override name = "CameraworkError";
}

/** Validates `data` against `schema`, or throws one CameraworkError listing every invalid field. */
export function parseWith<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new CameraworkError(`${what} is invalid: ${problems.join("; ")}`);
}
