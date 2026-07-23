// ============================================================================
// Rebuild data/river-markets.json by enumerating TroveManagers on-chain from
// each chain's SatoshiXApp diamond (FactoryFacet). Runs the RiverUpdater
// through the shared DataManager (same write path as the nightly
// update:dataset job). Deployment seeds stay in the static config/river.json.
// ============================================================================

import { DataManager } from "./data-manager.js";
import { RiverUpdater } from "./fetch/river/river.js";

async function main(): Promise<void> {
  const manager = new DataManager();
  manager.registerUpdater(new RiverUpdater());
  await manager.updateAll();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
