import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(root, "skills/camerawork/install.sh");
const FLAGS = ["--engine-only", "--skill-only", "--project", "--ref", "--no-ffmpeg", "--upgrade", "--help"];
const hasShellcheck = spawnSync("shellcheck", ["--version"]).status === 0;

describe("install.sh", () => {
  test("parses as bash", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
  });

  test("--help exits 0 and mentions every flag", () => {
    const r = spawnSync("bash", [script, "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const flag of FLAGS) expect(r.stdout).toContain(flag);
  });

  test("an unknown flag exits 1", () => {
    expect(spawnSync("bash", [script, "--nope"], { encoding: "utf8" }).status).toBe(1);
  });

  test("--skill-only copies the skill into HOME/.claude/skills", () => {
    const home = mkdtempSync(join(tmpdir(), "cw-home-"));
    const r = spawnSync("bash", [script, "--skill-only"], { encoding: "utf8", env: { ...process.env, HOME: home } });
    expect(r.status).toBe(0);
    const skill = join(home, ".claude/skills/camerawork");
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toStartWith("---\nname: camerawork\n");
    expect(existsSync(join(skill, "install.sh"))).toBe(true);
  });

  test.skipIf(!hasShellcheck)("passes shellcheck", () => {
    expect(spawnSync("shellcheck", [script]).status).toBe(0);
  });
});
