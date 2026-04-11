import { DataManager } from "./data-manager.js";
import { SiloV3Updater } from "./fetch/silo-v3.js";
// ============================================================================
// Usage Examples & Main Function
// ============================================================================
async function main() {
    const manager = new DataManager();
    // Register updaters
    // manager.registerUpdater(new MorphoBlueUpdater());
    // manager.registerUpdater(new MorphoOracleDataUpdater());
    // manager.registerUpdater(new AaveUpdater());
    // manager.registerUpdater(new CompoundV3Updater());
    // manager.registerUpdater(new CompoundV2Updater());
    // manager.registerUpdater(new InitUpdater());
    // manager.registerUpdater(new EulerUpdater());
    // manager.registerUpdater(new AaveV4Updater());
    // manager.registerUpdater(new AaveV4PeripheralsUpdater());
    // manager.registerUpdater(new SiloV2Updater());
    manager.registerUpdater(new SiloV3Updater());
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
