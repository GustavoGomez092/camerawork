// Builds dist/ when the package is installed from git (npm runs `prepare` for git dependencies).
// `npm install -g github:...` does not install devDependencies for the checkout (npm bug), so when the
// TypeScript compiler is missing this installs the dev dependencies locally first, then builds.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const run = (cmd, args, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!existsSync(tsc)) {
  console.log("camerawork: installing build dependencies");
  const env = { ...process.env, npm_config_global: "false", npm_config_location: "project" };
  run("npm", ["install", "--no-save", "--no-package-lock", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"], env);
}
run(process.execPath, [tsc, "-p", "tsconfig.build.json"]);
