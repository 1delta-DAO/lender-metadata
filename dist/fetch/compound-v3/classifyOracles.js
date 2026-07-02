import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import { probeFeedGraph, resolveFeed } from "../oracle-classifier/feedResolver.js";
import { asString, parsePair } from "../oracle-classifier/normalize.js";
import { assessFeed, dominantDenominator } from "../oracle-classifier/assess.js";
const cometOraclesFile = "./data/compound-v3-oracles.json";
const cometReservesFile = "./data/compound-v3-reserves.json";
const cometBaseDataFile = "./data/compound-v3-base-data.json";
export async function classifyCompoundV3Oracles() {
    const cometOracles = readJsonFile(cometOraclesFile);
    // compound-v3-oracles-data.json provides the human descriptions captured at fetch time.
    let rawData = {};
    try {
        rawData = readJsonFile("./data/compound-v3-oracles-data.json");
    }
    catch { }
    let baseData = {};
    try {
        baseData = readJsonFile(cometBaseDataFile);
    }
    catch { }
    const itemsByChain = new Map();
    for (const [comet, byChain] of Object.entries(cometOracles)) {
        for (const [chainId, byAsset] of Object.entries(byChain)) {
            for (const [asset, oracle] of Object.entries(byAsset)) {
                if (!itemsByChain.has(chainId))
                    itemsByChain.set(chainId, []);
                itemsByChain.get(chainId).push({
                    comet,
                    chainId,
                    asset: asset.toLowerCase(),
                    oracle: oracle.toLowerCase(),
                });
            }
        }
    }
    const result = {};
    for (const [chainId, items] of itemsByChain.entries()) {
        const oracles = [...new Set(items.map((i) => i.oracle))];
        const assets = [...new Set(items.map((i) => i.asset))];
        console.log(`Compound v3 oracles [${chainId}]: ${items.length} entries, ${oracles.length} unique feeds`);
        // 1. Walk the on-chain source graph for every comet price feed.
        const graph = await probeFeedGraph(chainId, oracles);
        const resolvedByOracle = new Map(oracles.map((o) => [o, resolveFeed(o, graph)]));
        // 2. Resolve asset symbols on-chain (no global symbol registry available).
        const symResults = (await multicallRetryUniversal({
            chain: chainId,
            calls: assets.map((a) => ({ address: a, name: "symbol", args: [] })),
            abi: SYMBOL_ABI,
            allowFailure: true,
            maxRetries: 12,
        }));
        const symbolByAsset = new Map();
        assets.forEach((a, i) => symbolByAsset.set(a, asString(symResults[i])));
        // 3. Per comet: build entries and derive the comet's pricing unit (denominator).
        const byComet = new Map();
        for (const it of items) {
            if (!byComet.has(it.comet))
                byComet.set(it.comet, []);
            byComet.get(it.comet).push(it);
        }
        for (const [comet, cometItems] of byComet.entries()) {
            const baseAsset = baseData[comet]?.[chainId]?.baseAsset?.toLowerCase() ?? null;
            const denoms = cometItems.map((it) => {
                const r = resolvedByOracle.get(it.oracle);
                return parsePair(r.priceDescription)?.quote ?? null;
            });
            // Comet values every collateral relative to the base token's price feed, so the
            // pricing unit is the base feed's denominator. Fall back to the dominant
            // denominator when the base feed is constant/unresolved (e.g. WETH comets).
            const baseItem = cometItems.find((it) => it.asset === baseAsset);
            const baseDenom = baseItem
                ? parsePair(resolvedByOracle.get(baseItem.oracle).priceDescription)?.quote ?? null
                : null;
            const unit = baseDenom && baseDenom.toUpperCase() !== "UNKNOWN"
                ? baseDenom.toUpperCase()
                : dominantDenominator(denoms);
            for (const it of cometItems) {
                const resolved = resolvedByOracle.get(it.oracle);
                const assetSymbol = symbolByAsset.get(it.asset) ?? null;
                // The comet values every collateral against its base feed, so the numeraire
                // is the comet's pricing unit derived above.
                const { denominator, intendedPair, correctOracle, denominatorMatch } = assessFeed(resolved, assetSymbol, unit);
                // prefer the raw description captured at fetch time, fall back to live readout
                const rawDescription = rawData[comet]?.[chainId]?.[it.asset]?.description ??
                    resolved.rawDescription ??
                    null;
                if (!result[comet])
                    result[comet] = {};
                if (!result[comet][chainId])
                    result[comet][chainId] = {};
                result[comet][chainId][it.asset] = {
                    oracle: it.oracle,
                    asset: it.asset,
                    assetSymbol,
                    isBase: baseAsset === it.asset,
                    rawDescription,
                    priceDescription: resolved.priceDescription,
                    provider: resolved.provider,
                    fixedRate: resolved.fixedRate,
                    underlyingAggregator: resolved.underlyingAggregator,
                    sourcePath: resolved.sourcePath,
                    denominator,
                    intendedPair,
                    correctOracle,
                    denominatorMatch,
                };
            }
        }
    }
    return result;
}
