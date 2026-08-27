// ============================================================================
// Rebuild config/termmax.json: the chain roster is discovered from TermMax's
// own API, then EVERY address is verified on-chain (router `getVersion`,
// viewer `getPositionDetails`, oracle `getPrice`, whitelist manager
// `isWhitelisted`) and anything that fails is dropped — a compromised or
// drifted API cannot inject an address.
//
// Chain config ONLY: there is deliberately no market roster. TermMax markets
// churn on every maturity roll and matured ones vanish upstream, so
// margin-fetcher discovers them at runtime instead.
// ============================================================================
import { DataManager } from "./data-manager.js";
import { TermMaxUpdater } from "./fetch/termmax/termmax.js";
async function main() {
    const manager = new DataManager();
    manager.registerUpdater(new TermMaxUpdater());
    await manager.updateAll();
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
