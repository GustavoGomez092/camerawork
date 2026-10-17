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

  describe("output validation (I3)", () => {
    const planned = async () => {
      const dir = tmpDir();
      const master = join(dir, "m.mp4");
      await makeBoxVideo(master, {
        width: 640,
        height: 360,
        fps: 30,
        seconds: 2,
        boxes: [{ x: 300, y: 150, size: 60, from: 1, to: 2 }],
      });
      const planPath = join(dir, "plan.json");
      const r = cli("plan", master, "-o", planPath, "--look", "flat", "--width", "320", "--formats", "mp4");
      expect(r.status).toBe(0);
      return { dir, master, planPath };
    };

    test("render into a missing directory is a CameraworkError naming it", async () => {
      const { planPath } = await planned();
      const r = cli("render", planPath, "-o", "nodir/x");
      expect(r.status).toBe(1);
      expect(r.stderr).toStartWith("camerawork: ");
      expect(r.stderr).toContain("nodir");
      expect(r.stderr).not.toContain("at ");
    });

    test("plan into a missing directory fails before detection", async () => {
      const { master } = await planned();
      const r = cli("plan", master, "-o", "nodir/plan.json");
      expect(r.status).toBe(1);
      expect(r.stderr).toStartWith("camerawork: ");
      expect(r.stderr).toContain("nodir");
    });

    test("detect into a missing directory fails with a CameraworkError", async () => {
      const { master } = await planned();
      const r = cli("detect", master, "-o", "nodir/c.json");
      expect(r.status).toBe(1);
      expect(r.stderr).toStartWith("camerawork: ");
      expect(r.stderr).toContain("nodir");
    });

    test("preview into a missing directory fails with a CameraworkError", async () => {
      const { planPath } = await planned();
      const r = cli("preview", planPath, "-o", "nodir/p");
      expect(r.status).toBe(1);
      expect(r.stderr).toStartWith("camerawork: ");
    });

    test("plan and detect without -o exit 2 before any detection work", async () => {
      const dir = tmpDir();
      const master = join(dir, "long.mp4");
      await makeBoxVideo(master, { width: 320, height: 180, fps: 10, seconds: 30, boxes: [] });
      for (const command of ["plan", "detect"]) {
        const t0 = performance.now();
        const r = cli(command, master);
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("-o");
        expect(performance.now() - t0).toBeLessThan(1500);
      }
    }, 60_000);
  });

  describe("flag allow-lists (I4)", () => {
    test("render-time output flags on render and preview point to plan", () => {
      for (const command of ["render", "preview"])
        for (const flag of ["--width", "--fps", "--formats", "--poster", "--max-bytes", "--quality", "--look"]) {
          const r = cli(command, "p.json", "-o", "x", flag, "1");
          expect(r.status).toBe(2);
          expect(r.stderr).toContain("set output options when planning: camerawork plan");
        }
      const r = cli("render", "p.json", "-o", "x", "--loop");
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("set output options when planning");
    });

    test("flags that belong to another command exit 2", () => {
      const cases: string[][] = [
        ["detect", "m.mp4", "-o", "x.json", "--width", "320"],
        ["detect", "m.mp4", "-o", "x.json", "--cues", "c.json"],
        ["plan", "m.mp4", "-o", "x.json", "--bogus-flag"],
        ["render", "p.json", "-o", "x", "--mask", "1,2,3,4"],
        ["preview", "p.json", "--cues", "c.json"],
      ];
      for (const args of cases) {
        const r = cli(...args);
        expect(r.status).toBe(2);
        expect(r.stderr).toStartWith("camerawork: ");
      }
    });
  });
});
