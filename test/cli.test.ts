import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBoxVideo, tmpDir } from "./helpers.js";

const cli = (...args: string[]) =>
  spawnSync("bun", [join(import.meta.dir, "../src/cli.ts"), ...args], { encoding: "utf8" });

describe("cli", () => {
  test("--version prints the package version", () => {
    const r = cli("--version");
    expect(r.status).toBe(0);
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { version: string };
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  test("plan → render writes the files", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, {
      width: 1280,
      height: 720,
      fps: 30,
      seconds: 3,
      boxes: [{ x: 500, y: 300, size: 80, from: 1, to: 3 }],
    });
    const planPath = join(dir, "plan.json");
    const planned = cli(
      "plan",
      master,
      "-o",
      planPath,
      "--look",
      "flat",
      "--width",
      "640",
      "--formats",
      "mp4",
      "--poster",
      "none",
      "--loop",
    );
    expect(planned.status).toBe(0);
    expect(cli("render", planPath, "-o", join(dir, "clip")).status).toBe(0);
    expect(existsSync(join(dir, "clip.mp4"))).toBe(true);
  });

  test("a CameraworkError exits 1 with a camerawork: prefix", () => {
    const r = cli("plan", "/nope/missing.mov", "-o", "/tmp/x.json");
    expect(r.status).toBe(1);
    expect(r.stderr).toStartWith("camerawork: cannot read /nope/missing.mov");
  });

  test("an unknown command exits 2 with usage", () => {
    const r = cli("frobnicate");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Usage:");
  });
});
