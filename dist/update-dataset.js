import { DataManager } from "./data-manager.js";
import { MorphoBlueUpdater } from "./fetch/morpho.js";
import { AaveUpdater } from "./fetch/aave.js";
import { CompoundV3Updater } from "./fetch/compound-v3.js";
import { InitUpdater } from "./fetch/init.js";
import { CompoundV2Updater } from "./fetch/compound-v2.js";
// ============================================================================
// Usage Examples & Main Function
// ============================================================================
async function main() {
    const manager = new DataManager();
    // Register updaters
    manager.registerUpdater(new MorphoBlueUpdater());
    manager.registerUpdater(new AaveUpdater());
    manager.registerUpdater(new CompoundV3Updater());
    manager.registerUpdater(new CompoundV2Updater());
    manager.registerUpdater(new InitUpdater());
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
