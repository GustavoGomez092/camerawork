#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { detect } from "./detect/index.js";
import { CameraworkError } from "./errors.js";
import { plan, readChangesFile, readCueFile, readJson, readPlan, writeJsonAtomic } from "./plan/index.js";
import { preview } from "./preview.js";
import { render } from "./render/index.js";
import type { Look, Rect } from "./schema.js";

const USAGE = `Usage:
  camerawork detect <master> -o <changes.json> [--mask x,y,w,h]...
  camerawork plan <master> -o <plan.json> [--cues f] [--changes f] [--look hero|flat|look.json] [--loop]
                  [--width N] [--fps N] [--formats mp4,webm] [--poster jpg|webp|none] [--max-bytes N]
                  [--quality medium|high] [--max-zoom N] [--min-hold N] [--mask x,y,w,h]...
  camerawork preview <plan.json> [-o <prefix>]
  camerawork render <plan.json> -o <prefix>
  camerawork --version`;

class UsageError extends Error {}

const version = (): string => {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
};

const num = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${v}"`);
  return n;
};

const rect = (v: string): Rect => {
  const parts = v.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)))
    throw new UsageError(`--mask must be x,y,w,h, got "${v}"`);
  return parts as Rect;
};

const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      mask: { type: "string", multiple: true },
      cues: { type: "string" },
      changes: { type: "string" },
      look: { type: "string" },
      loop: { type: "boolean" },
      width: { type: "string" },
      fps: { type: "string" },
      formats: { type: "string" },
      poster: { type: "string" },
      "max-bytes": { type: "string" },
      quality: { type: "string" },
      "max-zoom": { type: "string" },
      "min-hold": { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version) {
    console.log(version());
    return;
  }
  const [command, input] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const need = (v: string | undefined, what: string): string => {
    if (!v) throw new UsageError(`${command} needs ${what}`);
    return v;
  };
  const masks = (values.mask ?? []).map(rect);
  switch (command) {
    case "detect": {
      const changes = await detect(need(input, "a master video"), { masks });
      writeJsonAtomic(need(values.out, "-o <changes.json>"), changes);
      console.log(`${changes.changes.length} changes → ${values.out}`);
      return;
    }
    case "plan": {
      const look = values.look?.endsWith(".json") ? (readJson(values.look) as Look) : values.look;
      const poster = values.poster === "none" ? null : values.poster;
      const p = await plan(need(input, "a master video"), {
        cues: values.cues ? readCueFile(values.cues) : undefined,
        changes: values.changes ? readChangesFile(values.changes) : undefined,
        look,
        loop: values.loop ?? false,
        masks,
        output: defined({
          width: num("width", values.width),
          fps: num("fps", values.fps),
          formats: values.formats?.split(","),
          poster,
          maxBytes: num("max-bytes", values["max-bytes"]),
          quality: values.quality,
        }),
        planner: defined({
          maxZoom: num("max-zoom", values["max-zoom"]),
          minHold: num("min-hold", values["min-hold"]),
        }),
      });
      writeJsonAtomic(need(values.out, "-o <plan.json>"), p);
      console.log(
        `${p.shots.length} shots, ${p.keyframes.length} keyframes, max zoom ${p.maxZoom.toFixed(2)} → ${values.out}`,
      );
      return;
    }
    case "preview": {
      const planPath = need(input, "a plan.json");
      const { sheet, debug } = await preview(readPlan(planPath), {
        out: values.out ?? planPath.replace(/\.json$/, ""),
      });
      console.log(`${sheet}\n${debug}`);
      return;
    }
    case "render": {
      const files = await render(readPlan(need(input, "a plan.json")), {
        out: need(values.out, "-o <prefix>"),
        onProgress: (done, total) => {
          if (process.stderr.isTTY) process.stderr.write(`\rrendering ${done}/${total}`);
        },
      });
      if (process.stderr.isTTY) process.stderr.write("\n");
      console.log(files.join("\n"));
      return;
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CameraworkError) {
    console.error(`camerawork: ${error.message}`);
    process.exit(1);
  }
  if (error instanceof UsageError || String((error as { code?: string }).code).startsWith("ERR_PARSE_ARGS")) {
    console.error(`camerawork: ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
