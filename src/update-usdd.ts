// ============================================================================
// Rebuild data/usdd-markets.json: candidate ilks from USDD's chain-scoped
// public API (`latest-collateral?chain=`, collateralType 1 only — PSMs and
// the Smart Allocator are not markets), every candidate VERIFIED on-chain
// (Vat/Spot/Jug/Dog params, gem-join ilk round-trip; on-chain values win).
// Also reads `cdpManager.cdpi()` per chain — the USDD_PLAN.md re-evaluation
// trigger — so a first EVM CDP is visible in the run log. The roster is
// expected to be EMPTY until USDD governance files an EVM ilk.
// ============================================================================

import { DataManager } from "./data-manager.js";
import { UsddUpdater } from "./fetch/usdd/usdd.js";

async function main(): Promise<void> {
  const manager = new DataManager();
  manager.registerUpdater(new UsddUpdater());
  await manager.updateAll();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
