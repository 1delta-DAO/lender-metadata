// ============================================================================
// Rebuild data/twyne-markets.json: the whitelisted
// (intermediateVault, targetVault, targetAsset) triples, replayed from the
// VaultManager's whitelist EVENTS — there is no getter that enumerates them —
// then verified on chain, with the on-chain answer winning.
//
// A failed scan leaves the previous roster in place rather than publishing an
// empty one: with no built-in seed in data-sdk, an empty file takes the whole
// lender dark.
// ============================================================================
import { DataManager } from "./data-manager.js";
import { TwyneUpdater } from "./fetch/twyne/twyne.js";
async function main() {
    const manager = new DataManager();
    manager.registerUpdater(new TwyneUpdater());
    await manager.updateAll();
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
