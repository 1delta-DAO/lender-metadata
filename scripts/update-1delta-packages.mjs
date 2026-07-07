// ============================================================================
// Update every @1delta/* package to its latest published version in one shot.
//
// Discovers all @1delta-scoped packages from package.json (both dependencies
// and devDependencies), then runs `npm install <pkg>@latest …` for each group
// so package.json + package-lock.json are bumped and node_modules reinstalled.
// The `overrides` entries that reference `$@1delta/...` track the top-level
// dependency version, so they stay consistent automatically.
//
// Usage:
//   node scripts/update-1delta-packages.mjs        # update all @1delta/* deps
//   npm run update:1delta
//
// Flags:
//   --dry-run   print the npm commands without running them
// ============================================================================

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const SCOPE = "@1delta/";
const dryRun = process.argv.includes("--dry-run");

const scoped = (obj = {}) => Object.keys(obj).filter((name) => name.startsWith(SCOPE));

const prod = scoped(pkg.dependencies);
const dev = scoped(pkg.devDependencies);

if (prod.length === 0 && dev.length === 0) {
  console.log(`No ${SCOPE}* packages found in package.json.`);
  process.exit(0);
}

/** Run `npm install pkg@latest …` for one dependency group. */
function install(names, saveFlag) {
  if (names.length === 0) return;
  const specs = names.map((n) => `${n}@latest`);
  const args = ["install", saveFlag, ...specs];
  console.log(`\n$ npm ${args.join(" ")}`);
  if (dryRun) return;
  execFileSync("npm", args, { cwd: root, stdio: "inherit" });
}

console.log(
  `Updating ${prod.length + dev.length} ${SCOPE}* package(s) to latest:` +
    `\n  dependencies:    ${prod.join(", ") || "(none)"}` +
    `\n  devDependencies: ${dev.join(", ") || "(none)"}`,
);

install(prod, "--save");
install(dev, "--save-dev");

if (!dryRun) {
  console.log("\nDone. Review the version bumps in package.json / package-lock.json.");
}
