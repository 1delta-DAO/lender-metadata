// ============================================================================
// Rebuild data/liquity-markets.json by enumerating collateral branches
// on-chain from each deployment's CollateralRegistry. Runs the LiquityUpdater
// through the shared DataManager (same write path as the nightly
// update:dataset job). Deployment seeds + fork deviation params stay in the
// static config/liquity.json (aave-pools.json style: one row per deployment).
// ============================================================================

import { DataManager } from "./data-manager.js";
import { LiquityUpdater } from "./fetch/liquity/liquity.js";

async function main(): Promise<void> {
  const manager = new DataManager();
  manager.registerUpdater(new LiquityUpdater());
  await manager.updateAll();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
