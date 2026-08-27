// ============================================================================
// Fill config/morpho-type-markets.json with market ids discovered directly
// from the Morpho Blue core's `CreateMarket` events, for chains the main
// MorphoBlueUpdater never walks (i.e. not in MORPHO_MAIN_CHAIN_IDS) but that
// have a deployment in config/morpho-addresses.json. Append-only.
//
// Discovery is pure on-chain and uses the shared scanner (deploy-block search +
// budgeted, retrying, bisecting log scan), so a restrictive / unreachable RPC
// is reported as a failed chain rather than hanging the job.
//
// By default it targets every off-loop chain with a core; pass chain ids as CLI
// args to override (e.g. `tsx src/update-onchain-markets.ts 8217 5042`).
// ============================================================================
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { fetchMorphoMarketsByEvents } from "./fetch/morpho/fetchMorphoMarketsByEvents.js";
import { MORPHO_MAIN_CHAIN_IDS, cannotUseApi } from "./fetch/morpho/morpho.js";
import { hasSubgraph } from "./fetch/morpho/fetchMorphoSubgraph.js";
import { hasMysticApi } from "./fetch/morpho/fetchMysticApi.js";
const ADDRESSES_FILE = "./config/morpho-addresses.json";
const MARKETS_FILE = "./config/morpho-type-markets.json";
const FORK = "MORPHO_BLUE";
/**
 * Chains with a Morpho core whose market ids nothing else discovers.
 *
 * Off-loop chains qualify (the main updater never fetches them), but so do
 * IN-LOOP chains with no indexer: the main updater's on-chain path
 * (`getMarketsOnChain`) only ENRICHES ids already in morpho-type-markets.json —
 * it cannot find new ones. So a chain that is in the loop but has no Morpho
 * API, no subgraph and no Mystic coverage (MegaETH, Hemi, Berachain, BNB) would
 * silently never see a market created after its last event scan. Only chains
 * whose upstream indexer returns the full market list are skipped here.
 */
function defaultTargets() {
    const addresses = readJsonFile(ADDRESSES_FILE);
    const inLoop = new Set(MORPHO_MAIN_CHAIN_IDS);
    const discoveredUpstream = (chainId) => inLoop.has(chainId) &&
        (!cannotUseApi(chainId, FORK) ||
            hasSubgraph(chainId) ||
            hasMysticApi(chainId));
    return Object.keys(addresses).filter((chainId) => addresses[chainId]?.morpho && !discoveredUpstream(chainId));
}
async function main() {
    const cli = process.argv.slice(2);
    const target = cli.length ? cli : defaultTargets();
    const addresses = readJsonFile(ADDRESSES_FILE);
    let markets = {};
    try {
        markets = readJsonFile(MARKETS_FILE);
    }
    catch {
        markets = {};
    }
    if (!markets[FORK])
        markets[FORK] = {};
    console.log(`Discovering markets on ${target.length} chains: ${target.join(", ")}`);
    let added = 0;
    const failures = [];
    const results = await Promise.all(target.map(async (chainId) => {
        const core = addresses[chainId]?.morpho;
        if (!core) {
            console.warn(`  chain ${chainId}: no Morpho core in morpho-addresses`);
            failures.push(chainId);
            return null;
        }
        try {
            const found = await fetchMorphoMarketsByEvents(chainId, core);
            console.log(`  chain ${chainId}: discovered ${found.length} markets`);
            return { chainId, ids: found.map((m) => m.id) };
        }
        catch (err) {
            failures.push(chainId);
            console.warn(`  chain ${chainId}: market discovery failed: ${err?.message ?? err}`);
            return null;
        }
    }));
    for (const r of results) {
        if (!r)
            continue;
        const existing = new Set((markets[FORK][r.chainId] ?? []).map((s) => s.toLowerCase()));
        const before = existing.size;
        for (const id of r.ids)
            existing.add(id);
        if (existing.size === 0)
            continue; // don't create empty chain entries
        added += existing.size - before;
        markets[FORK][r.chainId] = [...existing].sort((a, b) => a.localeCompare(b));
    }
    const writeResult = await writeTextIfChanged(MARKETS_FILE, JSON.stringify(markets, null, 2) + "\n");
    console.log(`Added ${added} new market ids; file ${writeResult}.`);
    if (failures.length > 0) {
        console.warn(`Could not scan ${failures.length} chain(s) (unreachable RPC or too restrictive to scan in budget): ${failures.join(", ")}`);
    }
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
