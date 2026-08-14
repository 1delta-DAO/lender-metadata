import { DataManager } from "./data-manager.js";
import { writeTextIfChanged } from "./io.js";
import { AaveV4Updater } from "./fetch/aave-v4.js";
import { AaveV4PeripheralsUpdater } from "./fetch/aave-v4-peripherals.js";

/**
 * Run ONLY the Aave V4 passes (spokes/reserves/oracles + peripherals) instead
 * of the whole `update:dataset` sweep. Same updaters and the same merge
 * semantics — this just narrows the blast radius when the hub seed changes.
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
  manager.registerUpdater(new AaveV4Updater());
  manager.registerUpdater(new AaveV4PeripheralsUpdater());

  const written: string[] = [];

  for (const name of ["Aave V4", "Aave V4 Peripherals"]) {
    const res = await manager.updateFromSource(name);
    if (!res.success || !res.results) {
      console.error(`Failed: ${name}: ${res.error}`);
      continue;
    }
    for (const result of Object.values(res.results)) {
      const payload = JSON.stringify(result.data, null, 2) + "\n";
      const wrote = await writeTextIfChanged(result.targetFile, payload);
      if (wrote !== "skipped") written.push(result.targetFile);
    }
  }

  console.log(
    written.length === 0
      ? "No changes detected."
      : `Wrote ${written.length} file(s):\n  ${written.join("\n  ")}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
