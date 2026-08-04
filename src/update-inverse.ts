// ============================================================================
// Rebuild data/inverse-markets.json: roster discovered from Inverse's
// fixed-markets API, every candidate VERIFIED on-chain (on-chain values win),
// minDebt/dailyLimit from the BorrowController, labels + the config's DBR
// price snapshot refreshed. Runs the InverseUpdater through the shared
// DataManager (same write path as the nightly update:dataset job).
// ============================================================================

import { DataManager } from "./data-manager.js";
import { InverseUpdater } from "./fetch/inverse/inverse.js";

async function main(): Promise<void> {
  const manager = new DataManager();
  manager.registerUpdater(new InverseUpdater());
  await manager.updateAll();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
