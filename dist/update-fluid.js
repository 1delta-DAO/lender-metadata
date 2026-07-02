import { DataManager } from "./data-manager.js";
import { FluidUpdater } from "./fetch/fluid/fluid.js";
async function main() {
    const manager = new DataManager();
    manager.registerUpdater(new FluidUpdater());
    const result = await manager.updateFromSource("Fluid");
    if (!result.success) {
        throw new Error(result.error ?? "Fluid update failed");
    }
    process.exit(0); // <-- brute force
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
