import { parentPort } from "node:worker_threads";
import { shaderField } from "../backdrops/index.js";
import type { FrameDone, FrameJob } from "./backdrop-frames.js";

// A worker thread started by renderFrames: renders one field per message and transfers its pixels back.
parentPort?.on("message", (job: FrameJob) => {
  const px = shaderField(job.bd, job.w, job.h, job.frame / job.frames);
  const done: FrameDone = { frame: job.frame, px };
  parentPort?.postMessage(done, [px.buffer as ArrayBuffer]);
});
