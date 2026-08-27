// ============================================================================
// Rebuild data/term-finance-markets.json from the Term Finance subgraph.
//
// Term repos are single-maturity and expire, with new ones listed continuously,
// so this file cannot be a hand-committed snapshot: matured repos keep being
// advertised as borrowable, and freshly listed repos — the only ones with an
// OPEN auction, i.e. the only ones that can actually be borrowed — never show
// up at all. Same reasoning (and the same DataManager write path) as
// `update:midnight`.
//
// Run `update:term-labels` afterwards to name the new repos.
// Usage: `tsx src/update-term.ts`  (npm run update:term)
// ============================================================================
import { DataManager } from "./data-manager.js";
import { TermMarketsUpdater } from "./fetch/term/term.js";
async function main() {
    const manager = new DataManager();
    manager.registerUpdater(new TermMarketsUpdater());
    await manager.updateAll();
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
