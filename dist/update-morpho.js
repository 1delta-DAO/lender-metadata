import { DataManager } from "./data-manager.js";
import { MorphoBlueUpdater } from "./fetch/morpho/morpho.js";
async function main() {
    const manager = new DataManager();
    manager.registerUpdater(new MorphoBlueUpdater());
    const result = await manager.updateFromSource("Morpho Blue Markets");
    if (!result.success) {
        throw new Error(result.error ?? "Morpho update failed");
    }
    process.exit(0); // <-- brute force
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
