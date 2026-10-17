import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import type { LookInfo } from "../src/editor/protocol.js";
import { type EditorOptions, type EditorSession, openUrl, startEditor } from "../src/editor/server.js";
import { CameraworkError } from "../src/errors.js";
import { LOOKS, resolveLook } from "../src/looks.js";
import { PLACEHOLDER } from "../src/placeholder.js";
import { makeBoxVideo, tmpDir } from "./helpers.js";

const sessions: EditorSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

/** A fake built page, so these tests do not depend on the esbuild bundle. */
function fakeAssets(): string {
  const dir = join(tmpDir(), "editor");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>camerawork look editor</title>");
  writeFileSync(join(dir, "editor.js"), "console.log('editor')");
  writeFileSync(join(dir, "editor.css"), "body{}");
  return dir;
}

async function start(more: Partial<EditorOptions> = {}): Promise<{ session: EditorSession; out: string }> {
  const out = join(tmpDir(), "my look.json");
  const session = await startEditor({ out, look: resolveLook("hero"), assetsDir: fakeAssets(), ...more });
  sessions.push(session);
  return { session, out };
}

const post = (session: EditorSession, path: string, body: string, type = "application/json") =>
  fetch(new URL(path, session.url), { method: "POST", body, headers: { "content-type": type } });

/** A request with a chosen Host header (fetch does not allow setting it). */
function withHost(port: number, host: string): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/look", headers: { host } }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on("error", fail);
    req.end();
  });
}

describe("editor server", () => {
  test("binds 127.0.0.1 on a free port and serves the page files", async () => {
    const { session } = await start();
    expect(session.host).toBe("127.0.0.1");
    expect(session.url).toBe(`http://127.0.0.1:${session.port}/`);
    const page = await fetch(session.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("camerawork look editor");
    expect((await fetch(new URL("/editor.js", session.url))).headers.get("content-type")).toContain("javascript");
    expect((await fetch(new URL("/nope", session.url))).status).toBe(404);
  });

  test("an unbuilt page is refused up front, not served as a 500", async () => {
    await expect(
      startEditor({ out: join(tmpDir(), "l.json"), look: resolveLook("hero"), assetsDir: tmpDir() }),
    ).rejects.toThrow("the editor page is not built; run `npm run build`");
  });

  test("refuses other Host headers (DNS rebinding) and non-JSON saves", async () => {
    const { session } = await start();
    expect(await withHost(session.port, "evil.example")).toBe(403);
    expect(await withHost(session.port, `localhost:${session.port}`)).toBe(200);
    expect((await post(session, "/save", JSON.stringify(LOOKS.hero), "text/plain")).status).toBe(415);
  });

  test("without --master: the look, a placeholder window and its size (Review Focus 4)", async () => {
    const { session, out } = await start();
    const info = (await (await fetch(new URL("/look", session.url))).json()) as LookInfo;
    expect(info.hasMaster).toBe(false);
    expect(info.window).toEqual(PLACEHOLDER);
    expect(info.look).toEqual(LOOKS.hero);
    expect(info.out).toBe(out);
    const frame = await fetch(new URL("/frame?t=3", session.url));
    expect(frame.headers.get("content-type")).toBe("image/png");
    const img = await loadImage(Buffer.from(await frame.arrayBuffer()));
    expect([img.width, img.height]).toEqual([1920, 1080]);
  });

  test("with --master: its size and duration, and frames as JPEG", async () => {
    const master = join(tmpDir(), "m.mp4");
    await makeBoxVideo(master, { width: 640, height: 360, fps: 30, seconds: 2, boxes: [] });
    const { session } = await start({ master });
    const info = (await (await fetch(new URL("/look", session.url))).json()) as LookInfo;
    expect(info.hasMaster).toBe(true);
    expect([info.window.width, info.window.height]).toEqual([640, 360]);
    expect(info.window.duration).toBeCloseTo(2, 1);
    const frame = await fetch(new URL("/frame?t=0.5", session.url));
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    const img = await loadImage(Buffer.from(await frame.arrayBuffer()));
    expect([img.width, img.height]).toEqual([640, 360]);
    expect((await fetch(new URL("/frame?t=99", session.url))).status).toBe(200); // clamped to the last frame
  }, 30_000);

  test("an invalid look is a 400 naming the field; nothing is written and the session goes on", async () => {
    const { session, out } = await start();
    const bad = { ...LOOKS.hero, backdrop: { type: "shader", style: "silk", grain: 0.9 } };
    const reply = await post(session, "/save", JSON.stringify(bad));
    expect(reply.status).toBe(400);
    expect(((await reply.json()) as { error: string }).error).toContain("backdrop.grain");
    expect((await post(session, "/save", "{not json")).status).toBe(400);
    expect(existsSync(out)).toBe(false);
    expect((await fetch(new URL("/look", session.url))).status).toBe(200);
  });

  test("a valid save writes the file atomically (defaults filled in) and ends the session with its path", async () => {
    const { session, out } = await start();
    const look = { ...LOOKS.hero, backdrop: { type: "shader", style: "aurora", seed: 3 } };
    const reply = await post(session, "/save", JSON.stringify(look));
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ saved: out });
    expect(await session.done).toBe(out);
    const saved = JSON.parse(readFileSync(out, "utf8"));
    expect(saved.backdrop).toMatchObject({ type: "shader", style: "aurora", seed: 3, grain: 0.04 });
    expect(saved.backdrop.colors).toHaveLength(4);
    expect(existsSync(`${out}.tmp-${process.pid}`)).toBe(false);
    await expect(fetch(session.url)).rejects.toThrow();
  });

  test("ends without writing after the idle timeout; heartbeats keep it alive", async () => {
    const { session, out } = await start({ idleMs: 300, firstContactMs: 300 });
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 100));
      expect((await post(session, "/heartbeat", "")).status).toBe(204);
    }
    const t0 = performance.now();
    expect(await session.done).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(existsSync(out)).toBe(false);
  });

  test("a closed tab (/bye) ends the session within the short grace", async () => {
    const { session } = await start({ idleMs: 60_000 });
    await post(session, "/heartbeat", "");
    await post(session, "/bye", "");
    const t0 = performance.now();
    expect(await session.done).toBeNull();
    expect(performance.now() - t0).toBeLessThan(6000);
  }, 10_000);

  test("a port in use is a CameraworkError naming it (Review Focus 5)", async () => {
    const blocker = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(start({ port })).rejects.toThrow(CameraworkError);
      await expect(start({ port })).rejects.toThrow(`port ${port} is already in use`);
    } finally {
      blocker.close();
    }
  });

  test("openUrl reports a missing or failing browser opener instead of throwing (Review Focus 5)", async () => {
    expect(await openUrl("http://127.0.0.1:9/", "camerawork-no-such-opener")).toBe(false);
    expect(await openUrl("http://127.0.0.1:9/", "false")).toBe(false);
    expect(await openUrl("http://127.0.0.1:9/", "true")).toBe(true);
  });
});
