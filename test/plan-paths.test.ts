import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { plan, readPlan, writeJsonAtomic } from "../src/plan/index.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

const inDir = async <T>(dir: string, fn: () => Promise<T> | T): Promise<T> => {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
};

describe("plan file paths (I2)", () => {
  test("a plan made from a relative master path still finds the master from another directory", async () => {
    const dir = tmpDir();
    await makeBoxVideo(join(dir, "m.mp4"), { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const p = await inDir(dir, () => plan("m.mp4", { look: "flat", output: { width: 640 } }));
    expect(isAbsolute(p.master.path)).toBe(true);
    writeJsonAtomic(join(dir, "plan.json"), p);
    const read = await inDir(tmpDir(), () => readPlan(join(dir, "plan.json")));
    expect(isAbsolute(read.master.path)).toBe(true);
    expect(existsSync(read.master.path)).toBe(true);
  });

  test("readPlan resolves a relative master and backdrop image against the plan file's directory", async () => {
    const dir = tmpDir();
    await makeBoxVideo(join(dir, "m.mp4"), { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    writeFileSync(join(dir, "bg.png"), "");
    const p = await plan(join(dir, "m.mp4"), { look: "flat", output: { width: 640 } });
    const relative = {
      ...p,
      master: { ...p.master, path: "m.mp4" },
      look: { ...p.look, backdrop: { type: "image" as const, path: "bg.png" } },
    };
    writeJsonAtomic(join(dir, "plan.json"), relative);
    const read = await inDir(tmpDir(), () => readPlan(join(dir, "plan.json")));
    expect(realpathSync(read.master.path)).toBe(realpathSync(join(dir, "m.mp4")));
    expect(read.look.backdrop.type === "image" && realpathSync(read.look.backdrop.path)).toBe(
      realpathSync(join(dir, "bg.png")),
    );
  });
});
