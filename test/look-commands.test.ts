import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { BACKDROPS } from "../src/backdrops/presets.js";
import { startEditor } from "../src/editor/server.js";
import { sceneLayout } from "../src/geometry.js";
import { LOOKS, resolveLook } from "../src/looks.js";
import { PLACEHOLDER } from "../src/placeholder.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

const CLI = join(import.meta.dir, "../src/cli.ts");
const cli = (...args: string[]) => spawnSync("bun", [CLI, ...args], { encoding: "utf8" });

/** Starts the CLI and resolves the editor URL from its first line, and its exit once it ends. */
function background(args: string[], env: Record<string, string> = {}) {
  const proc = spawn("bun", [CLI, ...args], { env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d;
  });
  const url = new Promise<string>((ok) => {
    proc.stdout.on("data", (d) => {
      stdout += d;
      const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
      if (m) ok(m[0]);
    });
  });
  const exit = new Promise<{ code: number | null; stdout: string; stderr: string }>((ok) =>
    proc.on("close", (code) => ok({ code, stdout, stderr })),
  );
  return { url, exit };
}

describe("camerawork looks", () => {
  test("lists every look and backdrop preset with a description", () => {
    const r = cli("looks");
    expect(r.status).toBe(0);
    for (const name of [...Object.keys(LOOKS), ...Object.keys(BACKDROPS)]) expect(r.stdout).toContain(`  ${name} `);
    expect(r.stdout).toContain(BACKDROPS.ultraviolet?.description as string);
  });
});

describe("camerawork look preview", () => {
  test("writes a PNG of the scene size, or of --width, with a placeholder window", async () => {
    const dir = tmpDir();
    expect(cli("look", "preview", "ultraviolet", "-o", join(dir, "uv.png")).status).toBe(0);
    const layout = sceneLayout(PLACEHOLDER, resolveLook("ultraviolet"), 16 / 9);
    const full = await loadImage(join(dir, "uv.png"));
    expect([full.width, full.height]).toEqual([layout.sceneW, layout.sceneH]);
    expect(cli("look", "preview", "hero", "-o", join(dir, "hero.png"), "--width", "640").status).toBe(0);
    const small = await loadImage(join(dir, "hero.png"));
    expect([small.width, small.height]).toEqual([640, Math.round((layout.sceneH * 640) / layout.sceneW)]);
  }, 60_000);

  test("uses a frame of --master at --at, and refuses a time outside it", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 2, boxes: [] });
    const look = join(dir, "look.json");
    writeFileSync(look, JSON.stringify({ ...LOOKS.hero, backdrop: { type: "shader", style: "mesh" } }));
    const ok = cli("look", "preview", look, "--master", master, "--at", "1", "-o", join(dir, "p.png"));
    expect(ok.status).toBe(0);
    expect(existsSync(join(dir, "p.png"))).toBe(true);
    const late = cli("look", "preview", "hero", "--master", master, "--at", "9", "-o", join(dir, "q.png"));
    expect(late.status).toBe(1);
    expect(late.stderr).toContain("--at 9 is outside the master");
  }, 60_000);

  test("usage errors exit 2; an unknown preset exits 1 naming the choices", () => {
    expect(cli("look", "preview", "hero").status).toBe(2);
    expect(cli("look", "preview", "hero", "-o", "x.png", "--port", "1").status).toBe(2);
    expect(cli("look", "frobnicate").status).toBe(2);
    const r = cli("look", "preview", "sparkly", "-o", join(tmpDir(), "x.png"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("backdrops: ultraviolet");
  });
});

describe("plan --look <backdrop preset>", () => {
  test("records the hero window on that backdrop in plan.json", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 1, boxes: [] });
    const r = cli("plan", master, "-o", join(dir, "plan.json"), "--look", "dusk", "--width", "640");
    expect(r.status).toBe(0);
    const p = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
    expect(p.look.preset).toBe("dusk");
    expect(p.look.backdrop).toEqual(BACKDROPS.dusk?.backdrop);
    expect(p.look.padding).toBe(0.09);
  }, 60_000);
});

describe("camerawork look edit", () => {
  test("prints the URL, saves through the page's endpoint and exits 0", async () => {
    const out = join(tmpDir(), "my look.json");
    const run = background(["look", "edit", "-o", out, "--look", "glacier", "--no-open"]);
    const url = await run.url;
    const look = (await (await fetch(new URL("/look", url))).json()) as { look: unknown };
    const reply = await fetch(new URL("/save", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(look.look),
    });
    expect(reply.status).toBe(200);
    const { code, stdout } = await run.exit;
    expect(code).toBe(0);
    expect(stdout).toContain(`saved ${out}`);
    expect(JSON.parse(readFileSync(out, "utf8")).backdrop).toEqual(BACKDROPS.glacier?.backdrop);
  }, 30_000);

  test("exits 1 without writing when nobody saves before the idle timeout", async () => {
    const out = join(tmpDir(), "look.json");
    const run = background(["look", "edit", "-o", out, "--no-open"], { CAMERAWORK_EDITOR_IDLE_MS: "300" });
    const { code, stderr } = await run.exit;
    expect(code).toBe(1);
    expect(stderr).toContain("closed without saving; nothing was written");
    expect(existsSync(out)).toBe(false);
  }, 30_000);

  test("a bad or busy --port is reported before anything starts (Review Focus 5)", async () => {
    const out = join(tmpDir(), "look.json");
    expect(cli("look", "edit", "-o", out, "--port", "70000").status).toBe(2);
    const blocker = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = String((blocker.address() as { port: number }).port);
    try {
      const r = cli("look", "edit", "-o", out, "--port", port, "--no-open");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`port ${port} is already in use`);
    } finally {
      blocker.close();
    }
  });

  test("serves the real built page (the server and page agree on file names)", async () => {
    const assetsDir = join(tmpDir(), "editor");
    expect(spawnSync("node", [join(import.meta.dir, "../scripts/build-editor.mjs"), assetsDir]).status).toBe(0);
    const session = await startEditor({ out: join(tmpDir(), "l.json"), look: resolveLook("hero"), assetsDir });
    try {
      const page = await (await fetch(session.url)).text();
      expect(page).toContain("camerawork look editor");
      const js = await fetch(new URL("/editor.js", session.url));
      expect(js.status).toBe(200);
      expect((await js.text()).length).toBeGreaterThan(5000);
      expect((await fetch(new URL("/editor.css", session.url))).status).toBe(200);
    } finally {
      await session.close();
    }
  }, 60_000);
});

describe("look edit option validation", () => {
  test.each(["abc", "1.5", "-1", "65536"])("--port %s is a usage error (exit 2)", (port) => {
    const r = cli("look", "edit", "-o", join(tmpDir(), "l.json"), `--port=${port}`, "--no-open");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--port must be a whole number from 0 to 65535");
  });

  test("CAMERAWORK_EDITOR_IDLE_MS reaches the editor's idle timeout (and a junk value is ignored)", async () => {
    const out = join(tmpDir(), "l.json");
    const started = Date.now();
    const quick = await background(["look", "edit", "-o", out, "--no-open"], { CAMERAWORK_EDITOR_IDLE_MS: "200" }).exit;
    expect(quick.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
    const junk = background(["look", "edit", "-o", out, "--no-open"], { CAMERAWORK_EDITOR_IDLE_MS: "soon" });
    const url = await junk.url;
    await new Promise((r) => setTimeout(r, 800));
    expect((await fetch(url)).status).toBe(200); // still up: the default timeout applies
    await fetch(new URL("/save", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(((await (await fetch(new URL("/look", url))).json()) as { look: unknown }).look),
    });
    expect((await junk.exit).code).toBe(0);
  }, 30_000);
});

describe("look commands: fix round 1", () => {
  test("--at just under the master's duration finishes (it used to hang past the last frame)", async () => {
    const dir = tmpDir();
    const master = join(dir, "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 2, boxes: [] });
    const look = join(dir, "look.json");
    writeFileSync(look, JSON.stringify({ ...LOOKS.hero, backdrop: { type: "shader", style: "mesh" } }));
    for (const at of ["1.97", "1.99"]) {
      const r = spawnSync(
        "bun",
        [CLI, "look", "preview", look, "--master", master, "--at", at, "-o", join(dir, `${at}.png`)],
        {
          encoding: "utf8",
          timeout: 40_000,
        },
      );
      expect(r.status).toBe(0);
      expect(existsSync(join(dir, `${at}.png`))).toBe(true);
    }
  }, 120_000);

  test("--at without --master is a usage error", () => {
    const r = cli("look", "preview", "hero", "--at", "1", "-o", join(tmpDir(), "x.png"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--at needs --master");
  });

  test("a missing preset says which command needs it", () => {
    expect(cli("look", "preview", "-o", join(tmpDir(), "x.png")).stderr).toContain("look preview needs a look preset");
    expect(cli("look", "preview").stderr).toContain("look preview needs -o");
  });

  test("an image backdrop's relative path counts from the look file, not the working directory", async () => {
    const dir = tmpDir();
    const img = createCanvas(64, 64);
    const ctx = img.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 64, 64);
    writeFileSync(join(dir, "bg.png"), img.toBuffer("image/png"));
    writeFileSync(
      join(dir, "look.json"),
      JSON.stringify({ ...LOOKS.hero, backdrop: { type: "image", path: "bg.png" } }),
    );
    const r = spawnSync(
      "bun",
      [CLI, "look", "preview", join(dir, "look.json"), "-o", join(dir, "o.png"), "--width", "320"],
      {
        encoding: "utf8",
        cwd: tmpDir(),
      },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const out = await loadImage(join(dir, "o.png"));
    const c = createCanvas(out.width, out.height);
    const cx = c.getContext("2d");
    cx.drawImage(out, 0, 0);
    const [red, green] = cx.getImageData(3, 3, 1, 1).data;
    expect(red).toBeGreaterThan(150);
    expect(green).toBeLessThan(80);
  }, 60_000);
});
