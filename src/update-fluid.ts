import { DataManager } from "./data-manager.js";
import { writeTextIfChanged } from "./io.js";
import { FluidUpdater } from "./fetch/fluid/fluid.js";

/**
 * Run ONLY the Fluid pass (resolvers + vaults + labels) instead of the whole
 * `update:dataset` sweep.
 *
 * NOTE `DataManager.updateFromSource` computes the merged result but does NOT
 * write; only `updateAll` writes, via a private `writeAllResults`. So this
 * runner does the write itself with the same `writeTextIfChanged` +
 * 2-space-JSON-plus-newline payload the manager uses, and deliberately does
 * NOT touch `data/update-manifest.json` (a partial run should not claim to be
 * a full dataset version).
 */
async function main(): Promise<void> {
  const manager = new DataManager();

  manager.registerUpdater(new FluidUpdater());

  const result = await manager.updateFromSource("Fluid");
  if (!result.success || !result.results) {
    throw new Error(result.error ?? "Fluid update failed");
  }

  const written: string[] = [];
  for (const { data, targetFile } of Object.values(result.results)) {
    const payload = JSON.stringify(data, null, 2) + "\n";
    const wrote = await writeTextIfChanged(targetFile, payload);
    if (wrote !== "skipped") written.push(targetFile);
  }

  console.log(
    written.length === 0
      ? "No changes detected."
      : `Wrote ${written.length} file(s):\n  ${written.join("\n  ")}`,
  );

  process.exit(0); // <-- brute force
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
