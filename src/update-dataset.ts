import { DataManager } from "./data-manager.js";
import { MorphoBlueUpdater } from "./fetch/morpho/morpho.js";
import { MorphoOracleDataUpdater } from "./fetch/morpho-oracle-data.js";
import { AaveUpdater } from "./fetch/aave.js";
import { CompoundV3Updater } from "./fetch/compound-v3.js";
import { InitUpdater } from "./fetch/init.js";
import { CompoundV2Updater } from "./fetch/compound-v2.js";
import { EulerUpdater } from "./fetch/euler.js";
import { AaveV4Updater } from "./fetch/aave-v4.js";
import { AaveV4PeripheralsUpdater } from "./fetch/aave-v4-peripherals.js";
import { SiloV2Updater } from "./fetch/silo-v2.js";
import { SiloV3Updater } from "./fetch/silo-v3.js";
import { FluidUpdater } from "./fetch/fluid/fluid.js";

// ============================================================================
// Usage Examples & Main Function
// ============================================================================

async function main(): Promise<void> {
  const manager = new DataManager();

  // Register updaters
  manager.registerUpdater(new MorphoBlueUpdater());
  manager.registerUpdater(new MorphoOracleDataUpdater());
  manager.registerUpdater(new AaveUpdater());
  manager.registerUpdater(new CompoundV3Updater());
  manager.registerUpdater(new CompoundV2Updater());
  manager.registerUpdater(new InitUpdater());
  manager.registerUpdater(new EulerUpdater());
  manager.registerUpdater(new AaveV4Updater());
  manager.registerUpdater(new AaveV4PeripheralsUpdater());
  manager.registerUpdater(new SiloV2Updater());
  manager.registerUpdater(new SiloV3Updater());
  manager.registerUpdater(new FluidUpdater());

  // You can now update from specific sources:
  // await manager.updateFromSource("Morpho Blue Markets", { appendOnly: true });

  await manager.updateAll();
  process.exit(0); // <-- brute force
}

// Run if this is the main module

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
