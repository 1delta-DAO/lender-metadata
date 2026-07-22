import { DataManager } from "./data-manager.js";
import { MorphoBlueUpdater } from "./fetch/morpho/morpho.js";
import { writeTextIfChanged } from "./io.js";

async function main(): Promise<void> {
  const manager = new DataManager();

  manager.registerUpdater(new MorphoBlueUpdater());

  const result = await manager.updateFromSource("Morpho Blue Markets");
  if (!result.success || !result.results) {
    throw new Error(result.error ?? "Morpho update failed");
  }

  // `updateFromSource` merges into the existing data but does NOT persist it
  // (only `DataManager.updateAll()` writes, and this script calls the former).
  // Write the merged result for each target file here.
  for (const { data, targetFile } of Object.values(result.results)) {
    const wrote = await writeTextIfChanged(
      targetFile,
      JSON.stringify(data, null, 2) + "\n",
    );
    console.log(`  ${targetFile}: ${wrote}`);
  }

  process.exit(0); // <-- brute force
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
