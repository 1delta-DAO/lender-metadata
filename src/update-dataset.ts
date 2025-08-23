import { DataManager } from "./data-manager.js";
import { MorphoBlueUpdater } from "./fetch/morpho.js";
import { AaveUpdater } from "./fetch/aave.js";

// ============================================================================
// Usage Examples & Main Function
// ============================================================================

async function main(): Promise<void> {
  const manager = new DataManager();

  // Register updaters
  manager.registerUpdater(new MorphoBlueUpdater());
  manager.registerUpdater(new AaveUpdater());

  // You can now update from specific sources:
  // await manager.updateFromSource("Morpho Blue Markets", { appendOnly: true });

  // Or update from all sources (with append-only behavior):
  await manager.updateAll({ appendOnly: true });

  // Or update with full overwrite capability:
  // await manager.updateAll({ appendOnly: false });
}

// Run if this is the main module

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
