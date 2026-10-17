import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    ])
      expect(skill).toContain(word);
  });

  test("the README documents install, the skill link and every command", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    for (const word of [
      "npm install -g camerawork",
      "~/.claude/skills",
      "camerawork detect",
      "camerawork plan",
      "camerawork preview",
      "camerawork render",
      "ffmpeg",
    ])
      expect(readme).toContain(word);
    expect(readme).not.toContain("in design");
  });
});
