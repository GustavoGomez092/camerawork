import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { STYLE_NAMES } from "../src/backdrops/index.js";
import { BACKDROPS } from "../src/backdrops/presets.js";

const root = join(import.meta.dir, "..");

describe("docs", () => {
  test("the skill has frontmatter and covers the workflow and every CLI command", () => {
    const skill = readFileSync(join(root, "skills/camerawork/SKILL.md"), "utf8");
    expect(skill).toStartWith("---\nname: camerawork\ndescription: ");
    for (const word of [
      "camerawork plan",
      "camerawork preview",
      "camerawork render",
      "contact sheet",
      "cues.json",
      "--mask",
      "## Setup",
      "install.sh",
      "--engine-only",
      "raw.githubusercontent.com/GustavoGomez092/camerawork/main/skills/camerawork/install.sh",
      "camerawork looks",
      "camerawork look preview",
      "camerawork look edit --master",
      "Before planning, ask the user",
      "SIGTERM",
    ])
      expect(skill).toContain(word);
    expect(skill.indexOf("## Setup")).toBeLessThan(skill.indexOf("## Workflow"));
  });

  test("the README documents install, the skill link and every command", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    for (const word of [
      "skills/camerawork/install.sh | bash",
      "/plugin marketplace add GustavoGomez092/camerawork",
      "/plugin install camerawork@camerawork",
      "npm pack git+https://github.com/GustavoGomez092/camerawork.git",
      "npm install -g camerawork",
      "~/.claude/skills",
      "camerawork detect",
      "camerawork plan",
      "camerawork preview",
      "camerawork render",
      "ffmpeg",
      "camerawork looks",
      "camerawork look preview",
      "camerawork look edit",
      "## Backdrops",
      "## Look editor",
      "docs/images/backdrop-presets.jpg",
      "NOTICE",
      "SIGTERM",
    ])
      expect(readme).toContain(word);
    expect(readme).not.toContain("in design");
  });

  test("every backdrop preset and style is in the README, and the contact sheet is committed", async () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    for (const name of [...Object.keys(BACKDROPS), ...STYLE_NAMES]) expect(readme).toContain(`\`${name}\``);
    const sheet = await loadImage(join(root, "docs/images/backdrop-presets.jpg"));
    expect(sheet.width).toBe(1920);
  });

  test("NOTICE credits gradflow and ships with the package", () => {
    const notice = readFileSync(join(root, "NOTICE"), "utf8");
    expect(notice).toContain("github.com/meerbahadin/gradflow");
    expect(notice).toContain("MIT");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("NOTICE");
  });

  test("README and the skill document every flag of the CLI usage", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const skill = readFileSync(join(root, "skills/camerawork/SKILL.md"), "utf8");
    const usage = readFileSync(join(root, "src/cli.ts"), "utf8").match(/const USAGE = `([^`]*)`/)?.[1] ?? "";
    const flags = [...new Set(usage.match(/--[a-z][a-z-]*/g))].filter((f) => f !== "--version");
    expect(flags.length).toBeGreaterThan(10);
    for (const flag of flags) expect(readme).toContain(flag);
    for (const flag of flags.filter(
      (f) => !["--cues", "--changes", "--formats", "--poster", "--quality", "--fps"].includes(f),
    ))
      expect(skill).toContain(flag);
  });
});
