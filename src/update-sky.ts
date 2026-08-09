// ============================================================================
// Rebuild data/sky-markets.json: the original Maker (now Sky) dss vault
// roster, enumerated ENTIRELY on-chain from `ILK_REGISTRY.list()` and
// filtered to `class === 1` — the only ilk class that is a real user vault
// (class 5 allocators and class 6 LITE-PSM have no gem, class 7 LockstakeSky
// has its own write surface, class 3 RWA is permissioned). Offboarded ilks
// (`line == 0`) are kept and flagged: they hold user debt in run-off that
// still needs repay/withdraw. No API is involved anywhere.
// ============================================================================

import { DataManager } from "./data-manager.js";
import { SkyUpdater } from "./fetch/sky/sky.js";

async function main(): Promise<void> {
  const manager = new DataManager();
  manager.registerUpdater(new SkyUpdater());
  await manager.updateAll();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
