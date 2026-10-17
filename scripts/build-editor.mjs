// Bundles the look editor's page (editor/main.ts and the src/ modules it imports) for the browser with esbuild,
// next to its HTML and CSS. Usage: node scripts/build-editor.mjs [outDir]   (default dist/editor)
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, "dist", "editor"));
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, "editor", "main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: join(out, "editor.js"),
  logLevel: "warning",
});
for (const file of ["index.html", "editor.css"]) copyFileSync(join(root, "editor", file), join(out, file));
console.log(`editor → ${out}`);
