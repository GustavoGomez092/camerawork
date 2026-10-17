import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { ShaderBackdrop } from "../schema.js";

/** One frame for a backdrop worker: frame / frames is the loop time t. */
export interface FrameJob {
  bd: ShaderBackdrop;
  w: number;
  h: number;
  frame: number;
  frames: number;
}

/** A worker's answer: the field's RGBA bytes (their buffer is transferred, not copied). */
export interface FrameDone {
  frame: number;
  px: Uint8ClampedArray;
}

/** Worker threads for animated backdrops: one per core but one, at most 8. */
export const backdropThreads = (): number => Math.min(8, Math.max(1, availableParallelism() - 1));

/**
 * Renders frames 0 … frames-1 of an animated backdrop's field (w×h) on worker threads and hands them to `onFrame`
 * in order, one at a time. Each worker has one frame in flight and at most 2 × threads finished frames wait for
 * `onFrame`, so memory stays at a few fields however long the video is.
 */
export async function renderFrames(
  bd: ShaderBackdrop,
  w: number,
  h: number,
  frames: number,
  onFrame: (index: number, px: Uint8ClampedArray) => void | Promise<void>,
  threads = backdropThreads(),
): Promise<void> {
  if (!Number.isInteger(frames) || frames < 0)
    throw new RangeError(`frames must be a non-negative integer, got ${frames}`);
  if (frames === 0) return;
  // Bun runs the TypeScript sources (tests); Node runs the compiled .js next to this file.
  const url = new URL(`./backdrop-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url);
  const workers = Array.from({ length: Math.max(1, Math.min(threads, frames)) }, () => new Worker(url));
  const limit = 2 * workers.length;
  const ready = new Map<number, Uint8ClampedArray>();
  const idle = [...workers];
  let sent = 0;
  let written = 0;
  let failed = false;
  try {
    await new Promise<void>((resolve, reject) => {
      let chain = Promise.resolve();
      // The first failure wins: nothing more is sent to onFrame or the workers once it is set.
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        reject(error);
        for (const worker of workers) void worker.terminate();
      };
      const pump = () => {
        while (idle.length > 0 && sent < frames && sent - written < limit) {
          const job: FrameJob = { bd, w, h, frame: sent++, frames };
          (idle.pop() as Worker).postMessage(job);
        }
      };
      for (const worker of workers) {
        worker.on("error", fail);
        worker.on("exit", (code) => {
          if (written < frames) fail(new Error(`a backdrop worker exited early (code ${code})`));
        });
        worker.on("message", (done: FrameDone) => {
          if (failed) return;
          ready.set(done.frame, done.px);
          idle.push(worker);
          chain = chain
            .then(async () => {
              for (let px = ready.get(written); px && !failed; px = ready.get(written)) {
                ready.delete(written);
                await onFrame(written++, px);
              }
              if (failed) return;
              if (written === frames) resolve();
              else pump();
            })
            .catch(fail);
        });
      }
      pump();
    });
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
