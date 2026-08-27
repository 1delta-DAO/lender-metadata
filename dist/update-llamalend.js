// ============================================================================
// Rebuild data/llamalend-markets.json: roster discovered from Curve's API
// (one call covers every chain and BOTH generations), every candidate VERIFIED
// on-chain (on-chain values win), and `supportsDelegation` resolved per market
// by a runtime-bytecode selector scan.
//
// That last step is the reason this generator exists rather than a static
// roster: LlamaLend's boolean delegation grant only exists on newer-blueprint
// controllers (48 of 98 markets at 2026-08, none on Arbitrum), Curve keeps
// redeploying markets onto the newer blueprint, and getting it wrong in the
// optimistic direction produces on-behalf transactions that revert for every
// user of the market. Re-run it rather than hardcoding the fraction.
//
// Runs the LlamaLendUpdater through the shared DataManager (same write path as
// the nightly update:dataset job).
// ============================================================================
import { DataManager } from "./data-manager.js";
import { LlamaLendUpdater } from "./fetch/llamalend/llamalend.js";
async function main() {
    const manager = new DataManager();
    manager.registerUpdater(new LlamaLendUpdater());
    await manager.updateAll();
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
