import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { CameraworkError } from "../errors.js";
import { probe, readFrames, requireFfmpeg } from "../ffmpeg.js";
import { resolveLook } from "../looks.js";
import { PLACEHOLDER, placeholderWindow } from "../placeholder.js";
import { writeJsonAtomic } from "../plan/index.js";
import type { Look, Probe } from "../schema.js";
import { EDITOR_ASSETS, type LookInfo, type SaveReply } from "./protocol.js";

export interface EditorOptions {
  /** The look file Save writes (made absolute). */
  out: string;
  /** The starting look, already resolved. */
  look: Look;
  /** A master video: the preview shows its frames. Without it, a neutral placeholder window. */
  master?: string;
  /** 0 or left out: a free port. */
  port?: number;
  /** End an unsaved session this long after the last heartbeat (default 120 s). */
  idleMs?: number;
  /** End it this long after start if the page never connects (default 15 min). */
  firstContactMs?: number;
  /** Where index.html, editor.js and editor.css are (default: next to this module, else ../../dist/editor). */
  assetsDir?: string;
}

export interface EditorSession {
  /** http://127.0.0.1:<port>/ */
  url: string;
  host: string;
  port: number;
  /** Resolves with the saved file's path, or null when the session ended without a save. */
  done: Promise<string | null>;
  /** Ends the session now (as unsaved, unless already saved). */
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** The built page: next to the compiled server (dist/editor/), or dist/editor/ of a source checkout. */
function findAssets(dir?: string): string {
  if (dir) return dir;
  const here = dirname(fileURLToPath(import.meta.url));
  return existsSync(join(here, "index.html")) ? here : resolve(here, "../../dist/editor");
}

/** Opens a URL in the default browser (macOS `open`, Linux `xdg-open`). Resolves false when that fails. */
export function openUrl(url: string, command = process.platform === "darwin" ? "open" : "xdg-open"): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    const timer = setTimeout(() => {
      child.unref();
      done(true);
    }, 2000);
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(data));

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((ok, fail) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > limit) {
        fail(new CameraworkError("the look is too large"));
        req.destroy();
      }
    });
    req.on("end", () => ok(body));
    req.on("error", fail);
  });
}

/** One frame of the master at t seconds, at most 1920 px wide, as a JPEG. */
async function masterFrame(master: Probe, t: number): Promise<Buffer> {
  const w = Math.min(1920, master.width);
  const h = Math.max(2, Math.round((master.height * w) / master.width / 2) * 2);
  const at = Math.min(Math.max(0, t), Math.max(0, master.duration - 1.5 / master.fps)); // the last frame, not after it
  let frame: Buffer | null = null;
  await readFrames(
    ["-ss", at.toFixed(3), "-i", master.path, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-pix_fmt", "rgba"],
    w * h * 4,
    (f) => {
      frame = Buffer.from(f);
    },
  );
  if (!frame) throw new CameraworkError(`no frame at ${at.toFixed(2)} s`);
  const c = createCanvas(w, h);
  const pixels = frame as Buffer;
  c.getContext("2d").putImageData(
    new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length), w, h),
    0,
    0,
  );
  return c.toBuffer("image/jpeg", 88);
}

/**
 * The look editor's server (spec: backdrops §6): bound to 127.0.0.1 only. It serves the page, the starting look,
 * frames of the master, and saves the look (validated with the look schema, written atomically). The session ends
 * after a save, or after `idleMs` without a heartbeat from the page.
 */
export async function startEditor(opts: EditorOptions): Promise<EditorSession> {
  const out = resolve(opts.out);
  let master: Probe | null = null;
  if (opts.master) {
    requireFfmpeg();
    master = probe(opts.master);
  }
  const info: LookInfo = {
    look: opts.look,
    window: master ? { width: master.width, height: master.height, duration: master.duration } : PLACEHOLDER,
    hasMaster: master !== null,
    out,
  };
  const assets = findAssets(opts.assetsDir);
  if (!existsSync(join(assets, "index.html")))
    throw new CameraworkError("the editor page is not built; run `npm run build` (or `bun run build`) first");
  const idleMs = opts.idleMs ?? 120_000;
  const frames = new Map<string, Buffer>();
  let placeholder: Buffer | null = null;

  let finish: (saved: string | null) => void = () => {};
  const done = new Promise<string | null>((ok) => {
    finish = ok;
  });
  let timer: NodeJS.Timeout | undefined;
  let ended = false;
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof CameraworkError ? error.message : String(error);
      if (!res.headersSent) json(res, 500, { error: message });
    });
  });
  const end = (saved: string | null) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    finish(saved);
  };
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => end(null), ms);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { port } = server.address() as AddressInfo;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`)
      return send(res, 403, "text/plain", "forbidden");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const route = `${req.method} ${url.pathname}`;
    if (route === "POST /heartbeat") {
      arm(idleMs);
      return send(res, 204, "text/plain", "");
    }
    if (route === "POST /bye") {
      arm(Math.min(idleMs, 5000)); // the tab closed; a reload heartbeats again within this grace
      return send(res, 204, "text/plain", "");
    }
    if (route === "GET /look") return json(res, 200, info);
    if (route === "GET /frame") {
      if (!master) {
        placeholder ??= placeholderWindow();
        return send(res, 200, "image/png", placeholder);
      }
      const key = (Number(url.searchParams.get("t")) || 0).toFixed(2);
      let jpeg = frames.get(key);
      if (!jpeg) {
        jpeg = await masterFrame(master, Number(key));
        if (frames.size >= 64) frames.delete(frames.keys().next().value as string);
        frames.set(key, jpeg);
      }
      return send(res, 200, "image/jpeg", jpeg);
    }
    if (route === "POST /save") {
      if (!String(req.headers["content-type"]).startsWith("application/json"))
        return json(res, 415, { error: "send the look as application/json" } satisfies SaveReply);
      let look: Look;
      try {
        look = resolveLook(JSON.parse(await readBody(req, 1_000_000)) as Look);
      } catch (error) {
        const message = error instanceof CameraworkError ? error.message : "the look is not valid JSON";
        return json(res, 400, { error: message } satisfies SaveReply);
      }
      try {
        writeJsonAtomic(out, look);
      } catch (error) {
        return json(res, 500, { error: `cannot write ${out}: ${(error as Error).message}` } satisfies SaveReply);
      }
      res.on("finish", () => end(out));
      return json(res, 200, { saved: out } satisfies SaveReply);
    }
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (req.method === "GET" && (EDITOR_ASSETS as readonly string[]).includes(name)) {
      const path = join(assets, name);
      if (!existsSync(path))
        return send(res, 500, "text/plain", `the editor page is not built (${path} is missing): run the build first`);
      return send(res, 200, TYPES[extname(name)] ?? "application/octet-stream", readFileSync(path));
    }
    return send(res, 404, "text/plain", "not found");
  }

  await new Promise<void>((ok, fail) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE")
        fail(new CameraworkError(`port ${opts.port} is already in use: pick another --port, or leave it out`));
      else if (error.code === "EACCES")
        fail(new CameraworkError(`port ${opts.port} needs special permissions: pick a port above 1024`));
      else fail(error);
    });
    server.listen(opts.port ?? 0, "127.0.0.1", () => ok());
  });
  arm(opts.firstContactMs ?? 900_000);
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    host: address,
    port,
    done,
    close: async () => {
      end(null);
      await done;
    },
  };
}
