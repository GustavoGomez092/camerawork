import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { CameraworkError } from "./errors.js";
import type { Probe } from "./schema.js";

const INSTALL_HINT = "Install ffmpeg 6 or later (macOS: brew install ffmpeg; Debian/Ubuntu: sudo apt install ffmpeg).";

/** Throws unless ffmpeg and ffprobe 6+ are on PATH. Git builds ("version N-…") are accepted. */
export function requireFfmpeg(): void {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    const result = spawnSync(bin, ["-version"], { encoding: "utf8" });
    if (result.error || result.status !== 0) throw new CameraworkError(`${bin} was not found on PATH. ${INSTALL_HINT}`);
    const major = /version n?(\d+)\./.exec(result.stdout)?.[1];
    if (major && Number(major) < 6) throw new CameraworkError(`${bin} ${major} is too old. ${INSTALL_HINT}`);
  }
}

function rate(value: string | undefined): number {
  const [num, den] = (value ?? "0/0").split("/").map(Number);
  return num && den ? num / den : 0;
}

/** Size, frame rate and duration of a video's first video stream. */
export function probe(path: string): Probe {
  if (!existsSync(path)) throw new CameraworkError(`cannot read ${path}: no such file`);
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,r_frame_rate:format=duration",
      "-of",
      "json",
      path,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new CameraworkError(`cannot read ${path}: ${result.stderr.trim()}`);
  const json = JSON.parse(result.stdout) as {
    streams?: { width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const stream = json.streams?.[0];
  if (!stream?.width || !stream.height) throw new CameraworkError(`${path} has no video stream`);
  const fps = rate(stream.avg_frame_rate) || rate(stream.r_frame_rate);
  const duration = Number(json.format?.duration);
  if (!fps || !duration) throw new CameraworkError(`cannot read the frame rate or duration of ${path}`);
  return { path, width: stream.width, height: stream.height, fps: Math.round(fps * 1000) / 1000, duration };
}

let encoders: string | null = null;
/** True when this ffmpeg build has the named encoder. */
export function hasEncoder(name: string): boolean {
  encoders ??= spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "";
  return encoders.split("\n").some((line) => line.trim().split(/\s+/)[1] === name);
}

function failure(args: string[], code: number | null, stderr: string): CameraworkError {
  const tail = stderr.trim().split("\n").slice(-6).join("\n");
  return new CameraworkError(`ffmpeg failed (exit ${code}) running: ffmpeg ${args.join(" ")}\n${tail}`);
}

/** Runs `ffmpeg -v error -y …args` to completion. */
export function runFfmpeg(args: string[]): Promise<void> {
  const full = ["-v", "error", "-y", ...args];
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", full, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(failure(full, code, stderr))));
  });
}

/**
 * Runs `ffmpeg -v error …args -f rawvideo -` and calls `onFrame` once per complete frame, in order, one at a time.
 * The frame buffer is reused between calls: copy it to keep it.
 */
export function readFrames(
  args: string[],
  frameBytes: number,
  onFrame: (frame: Buffer, index: number) => void | Promise<void>,
): Promise<number> {
  const full = ["-v", "error", ...args, "-f", "rawvideo", "-"];
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", full, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    const frame = Buffer.allocUnsafe(frameBytes);
    let filled = 0;
    let index = 0;
    let failed: unknown = null;
    let work: Promise<void> = Promise.resolve();
    proc.stdout.on("data", (chunk: Buffer) => {
      proc.stdout.pause();
      work = work.then(async () => {
        let offset = 0;
        while (offset < chunk.length && !failed) {
          const n = Math.min(frameBytes - filled, chunk.length - offset);
          chunk.copy(frame, filled, offset, offset + n);
          filled += n;
          offset += n;
          if (filled === frameBytes) {
            filled = 0;
            try {
              await onFrame(frame, index++);
            } catch (error) {
              failed = error;
              proc.kill("SIGKILL");
            }
          }
        }
        proc.stdout.resume();
      });
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      work.then(() => {
        if (failed) reject(failed);
        else if (code !== 0) reject(failure(full, code, stderr));
        else resolve(index);
      }, reject);
    });
  });
}

/** An ffmpeg process that reads raw frames on stdin (the args must include `-i -`). */
export class FrameSink {
  private readonly proc;
  private readonly done: Promise<void>;
  private exited = false;

  constructor(args: string[]) {
    const full = ["-v", "error", "-y", ...args];
    this.proc = spawn("ffmpeg", full, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    this.proc.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    this.proc.stdin.on("error", () => {}); // a dead encoder is reported through `done`
    this.done = new Promise((resolve, reject) => {
      this.proc.on("error", reject);
      this.proc.on("close", (code) => (code === 0 ? resolve() : reject(failure(full, code, stderr))));
    });
    this.done.then(
      () => {
        this.exited = true;
      },
      () => {
        this.exited = true;
      },
    ); // failures are observed by write()/end()
  }

  /** Resolves when the frame is accepted; rejects with the encoder's CameraworkError if ffmpeg has died. */
  write(frame: Buffer): Promise<void> {
    if (this.exited) return this.done;
    const stdin = this.proc.stdin;
    if (stdin.destroyed || stdin.writableEnded)
      return this.done.then(() => Promise.reject(new CameraworkError("ffmpeg input is closed")));
    if (stdin.write(frame)) return Promise.resolve();
    return Promise.race([
      new Promise<void>((resolve) => stdin.once("drain", () => resolve())),
      this.done.then(() => Promise.reject(new CameraworkError("ffmpeg exited while frames were still being written"))),
    ]);
  }

  end(): Promise<void> {
    this.proc.stdin.end();
    return this.done;
  }

  /** Kills the process and resolves once it has exited. Never rejects. */
  async kill(): Promise<void> {
    if (!this.exited) this.proc.kill("SIGKILL");
    await this.done.catch(() => {});
  }
}
