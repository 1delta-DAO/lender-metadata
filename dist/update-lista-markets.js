// ============================================================================
// Populate the LISTA_DAO section of config/morpho-type-markets.json from the
// Lista moolah API. Append-only: existing market ids are never removed.
// Run as a separate job because the API is access-restricted.
// Also cross-references the new markets' loan/collateral token addresses
// against the 1delta-DAO token list and writes a log of any missing assets.
// ============================================================================
import { zeroAddress } from "viem";
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { fetchListaMarkets, resolveListaMarketAssets, } from "./fetch/morpho/fetchListaApi.js";
const MARKETS_FILE = "./config/morpho-type-markets.json";
const POOLS_FILE = "./config/morpho-pools.json";
const MISSING_ASSETS_LOG = "./data/lista-missing-assets.log";
const FORK = "LISTA_DAO";
const tokenListUrl = (chainId) => `https://raw.githubusercontent.com/1delta-DAO/token-lists/main/${chainId}.json`;
async function loadTokenList(chainId) {
    const res = await fetch(tokenListUrl(chainId));
    if (!res.ok) {
        throw new Error(`Token list fetch failed for chain ${chainId}: ${res.status}`);
    }
    const body = (await res.json());
    return new Set(Object.keys(body.list).map((a) => a.toLowerCase()));
}
async function main() {
    const markets = await fetchListaMarkets();
    const totalFetched = Object.values(markets).reduce((acc, ids) => acc + ids.length, 0);
    console.log(`Fetched ${totalFetched} Lista markets across ${Object.keys(markets).length} chains`);
    const existing = readJsonFile(MARKETS_FILE);
    const pools = readJsonFile(POOLS_FILE);
    if (!existing[FORK])
        existing[FORK] = {};
    let added = 0;
    const newlyAddedByChain = {};
    for (const [chainId, ids] of Object.entries(markets)) {
        const current = existing[FORK][chainId] ?? [];
        const set = new Set(current);
        const fresh = [];
        for (const id of ids) {
            if (!set.has(id)) {
                set.add(id);
                fresh.push(id);
                added++;
            }
        }
        existing[FORK][chainId] = Array.from(set).sort();
        if (fresh.length > 0)
            newlyAddedByChain[chainId] = fresh;
    }
    const writeResult = await writeTextIfChanged(MARKETS_FILE, JSON.stringify(existing, null, 2) + "\n");
    console.log(`Added ${added} new Lista market ids; file ${writeResult}.`);
    const missing = [];
    for (const [chainId, ids] of Object.entries(newlyAddedByChain)) {
        const poolAddress = pools?.[FORK]?.[chainId];
        if (!poolAddress) {
            console.warn(`No ${FORK} pool configured for chain ${chainId}; skipping asset check.`);
            continue;
        }
        let assets;
        try {
            assets = await resolveListaMarketAssets(chainId, poolAddress, ids);
        }
        catch (err) {
            console.warn(`Asset resolution failed for chain ${chainId}:`, err);
            continue;
        }
        let tokenSet;
        try {
            tokenSet = await loadTokenList(chainId);
        }
        catch (err) {
            console.warn(`Token list fetch failed for chain ${chainId}:`, err);
            continue;
        }
        for (const a of assets) {
            const missingTokens = [];
            const check = (t) => {
                if (!t || t === zeroAddress)
                    return;
                if (!tokenSet.has(t))
                    missingTokens.push(t);
            };
            check(a.loanToken);
            check(a.collateralToken);
            if (missingTokens.length > 0) {
                missing.push({
                    chainId,
                    marketId: a.marketId,
                    missing: Array.from(new Set(missingTokens)),
                    loanToken: a.loanToken,
                    collateralToken: a.collateralToken,
                });
            }
        }
    }
    if (missing.length === 0) {
        console.log("No missing assets in the 1delta-DAO token lists.");
    }
    else {
        const lines = [
            `# Lista market assets missing from 1delta-DAO token lists`,
            `# generated: ${new Date().toISOString()}`,
            `# entries: ${missing.length}`,
            ``,
        ];
        for (const m of missing) {
            lines.push(`chain=${m.chainId} market=${m.marketId} loan=${m.loanToken} collateral=${m.collateralToken} missing=${m.missing.join(",")}`);
        }
        await writeTextIfChanged(MISSING_ASSETS_LOG, lines.join("\n") + "\n");
        console.log(`Logged ${missing.length} markets with missing assets to ${MISSING_ASSETS_LOG}`);
    }
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
