#!/usr/bin/env node
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BACKDROPS } from "./backdrops/presets.js";
import { detect } from "./detect/index.js";
import { openUrl, startEditor } from "./editor/server.js";
import { CameraworkError } from "./errors.js";
import { lookPreview } from "./look-preview.js";
import { LOOK_DESCRIPTIONS, LOOKS, resolveLook } from "./looks.js";
import { plan, readChangesFile, readCueFile, readJson, readPlan, writeJsonAtomic } from "./plan/index.js";
import { preview } from "./preview.js";
import { render } from "./render/index.js";
import type { Look, Rect } from "./schema.js";

const USAGE = `Usage:
  camerawork detect <master> -o <changes.json> [--mask x,y,w,h]...
  camerawork plan <master> -o <plan.json> [--cues f] [--changes f] [--look <preset|look.json>] [--loop]
                  [--width N] [--fps N] [--formats mp4,webm] [--poster jpg|webp|none] [--max-bytes N]
                  [--quality medium|high] [--max-zoom N] [--min-hold N] [--mask x,y,w,h]...
  camerawork preview <plan.json> [-o <prefix>]
  camerawork render <plan.json> -o <prefix>
  camerawork looks
  camerawork look preview <preset|look.json> -o <look.png> [--master <video>] [--at seconds] [--width N]
  camerawork look edit -o <look.json> [--master <video>] [--look <preset|look.json>] [--port N] [--no-open]
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

const OUTPUT_FLAGS = ["width", "fps", "formats", "poster", "max-bytes", "quality", "loop", "look"];
const PLAN_FLAGS = [...OUTPUT_FLAGS, "out", "mask", "cues", "changes", "max-zoom", "min-hold"];
const ALLOWED: Record<string, string[]> = {
  detect: ["out", "mask"],
  plan: PLAN_FLAGS,
  preview: ["out"],
  render: ["out"],
  looks: [],
  "look preview": ["out", "master", "at", "width"],
  "look edit": ["out", "master", "look", "port", "no-open"],
};

/** Exit 2 for any flag the command does not take. */
function checkFlags(command: string, given: string[]): void {
  const allowed = ALLOWED[command];
  if (!allowed) return;
  for (const flag of given) {
    if (allowed.includes(flag) || flag === "version" || flag === "help") continue;
    if ((command === "render" || command === "preview") && OUTPUT_FLAGS.includes(flag))
      throw new UsageError(
        `--${flag} is not an option of ${command}: set output options when planning: camerawork plan <master> -o <plan.json> --${flag} …`,
      );
    throw new UsageError(`--${flag} is not an option of ${command}`);
  }
}

/** Fails now, before any expensive work, when the output's directory is missing or not writable. */
function checkOutputDir(out: string): void {
  const dir = resolve(dirname(out));
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
    if (ok) accessSync(dir, constants.W_OK);
  } catch {
    ok = false;
  }
  if (!ok)
    throw new CameraworkError(
      `cannot write ${out}: the directory ${dir} does not exist or is not writable. Create it or choose another -o.`,
    );
}

/** A look argument: a path ending in .json is read as a look file; anything else is a preset name. */
const lookArg = (v: string | undefined): string | Look | undefined =>
  v?.endsWith(".json") ? (readJson(v) as Look) : v;

/** `camerawork looks`: every look preset and backdrop preset, one line each. */
function listLooks(): string {
  const pad = Math.max(...[...Object.keys(LOOKS), ...Object.keys(BACKDROPS)].map((n) => n.length)) + 2;
  const lines = ["Looks (the window and its backdrop):"];
  for (const [name, text] of Object.entries(LOOK_DESCRIPTIONS)) lines.push(`  ${name.padEnd(pad)}${text}`);
  lines.push("", "Backdrops (--look <name> puts the hero window on it):");
  for (const [name, preset] of Object.entries(BACKDROPS)) lines.push(`  ${name.padEnd(pad)}${preset.description}`);
  return lines.join("\n");
}

/** The editor's idle timeout: CAMERAWORK_EDITOR_IDLE_MS (a test knob), else the server's defaults. */
function idleKnob(): { idleMs?: number; firstContactMs?: number } {
  const ms = Number(process.env.CAMERAWORK_EDITOR_IDLE_MS);
  return Number.isFinite(ms) && ms > 0 ? { idleMs: ms, firstContactMs: ms } : {};
}

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
      master: { type: "string" },
      at: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version) {
    console.log(version());
    return;
  }
  const [command, input, lookInput] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const need = (v: string | undefined, what: string): string => {
    if (!v) throw new UsageError(`${command} needs ${what}`);
    return v;
  };
  checkFlags(command === "look" ? `look ${input ?? ""}` : command, Object.keys(values));
  if (command === "detect" || command === "plan" || command === "render")
    checkOutputDir(
      need(
        values.out,
        command === "plan" ? "-o <plan.json>" : command === "detect" ? "-o <changes.json>" : "-o <prefix>",
      ),
    );
  if (command === "preview" && values.out) checkOutputDir(values.out);
  if (command === "look" && (input === "preview" || input === "edit"))
    checkOutputDir(need(values.out, input === "preview" ? "-o <look.png>" : "-o <look.json>"));
  const masks = (values.mask ?? []).map(rect);
  switch (command) {
    case "detect": {
      const changes = await detect(need(input, "a master video"), { masks });
      writeJsonAtomic(need(values.out, "-o <changes.json>"), changes);
      console.log(`${changes.changes.length} changes → ${values.out}`);
      return;
    }
    case "plan": {
      const look = lookArg(values.look);
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
    case "looks":
      console.log(listLooks());
      return;
    case "look": {
      if (input === "preview") {
        const look = resolveLook(lookArg(need(lookInput, "a look preset or look.json")) as string | Look);
        const png = await lookPreview(look, {
          out: need(values.out, "-o <look.png>"),
          master: values.master,
          at: num("at", values.at),
          width: num("width", values.width),
        });
        console.log(png);
        return;
      }
      if (input === "edit") {
        const port = values.port === undefined ? undefined : /^\d+$/.test(values.port) ? Number(values.port) : -1;
        if (port !== undefined && !(port >= 0 && port <= 65535))
          throw new UsageError(`--port must be a whole number from 0 to 65535, got "${values.port}"`);
        const session = await startEditor({
          out: need(values.out, "-o <look.json>"),
          look: resolveLook(lookArg(values.look) ?? "hero"),
          master: values.master,
          port,
          ...idleKnob(),
        });
        console.log(`camerawork look editor: ${session.url}  (Save in the page to write ${values.out})`);
        if (!values["no-open"] && !(await openUrl(session.url)))
          console.error(`camerawork: could not open a browser; open ${session.url} yourself`);
        const saved = await session.done;
        if (!saved) throw new CameraworkError("the editor was closed without saving; nothing was written");
        console.log(`saved ${saved}`);
        return;
      }
      throw new UsageError(`unknown look command "${input ?? ""}" (use: look preview, look edit)`);
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
