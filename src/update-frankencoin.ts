// ============================================================================
// Rebuild data/frankencoin-markets.json: ORIGINAL positions discovered from
// Frankencoin's public API (`/positions/open`), filtered to version 2 + open
// + a CURATED COLLATERAL ALLOWLIST (~40% of the live book is unpriceable
// RWA/equity collateral), then every candidate VERIFIED on-chain with
// on-chain values winning. Clones are user positions, discovered per-account
// at request time — they are deliberately not stored here.
// ============================================================================

import { DataManager } from "./data-manager.js";
import { FrankencoinUpdater } from "./fetch/frankencoin/frankencoin.js";

async function main(): Promise<void> {
  const manager = new DataManager();
  manager.registerUpdater(new FrankencoinUpdater());
  await manager.updateAll();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
