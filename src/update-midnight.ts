// ============================================================================
// Rebuild data/midnight-markets.json from the Morpho Midnight API. Runs the
// MidnightUpdater through the shared DataManager (same write path as the
// nightly update:dataset job). Deployment addresses stay in the static
// config/midnight.json, which drives which chains/API this fetches.
// ============================================================================

import { DataManager } from "./data-manager.js";
import { MidnightUpdater } from "./fetch/midnight/midnight.js";

async function main(): Promise<void> {
  const manager = new DataManager();
  manager.registerUpdater(new MidnightUpdater());
  await manager.updateAll();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
