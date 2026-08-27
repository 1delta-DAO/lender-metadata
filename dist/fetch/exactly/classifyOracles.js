import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import { probeFeedGraph, resolveFeed, } from "../oracle-classifier/feedResolver.js";
import { asString, toAddr } from "../oracle-classifier/normalize.js";
import { assessFeed } from "../oracle-classifier/assess.js";
// config/exactly.json: chain -> { auditor, previewer, ... }
const configFile = "./config/exactly.json";
// data/exactly-markets.json: chain -> [{ market, asset, assetSymbol, ... }]
const marketsFile = "./data/exactly-markets.json";
const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a) => typeof a === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(a) &&
    a.toLowerCase() !== ZERO;
// Auditor.markets(market) → (adjustFactor, decimals, index, isListed, priceFeed)
const AUDITOR_ABI = [
    {
        name: "markets",
        stateMutability: "view",
        type: "function",
        inputs: [{ type: "address" }],
        outputs: [
            { name: "adjustFactor", type: "uint128" },
            { name: "decimals", type: "uint8" },
            { name: "index", type: "uint8" },
            { name: "isListed", type: "bool" },
            { name: "priceFeed", type: "address" },
        ],
    },
];
/**
 * Classify Exactly's per-market price oracles.
 *
 * Exactly registers ONE Chainlink-style price feed per Market on the Auditor
 * (`markets(market).priceFeed`), always USD-denominated (the protocol prices
 * everything in 1e18 USD). Each feed is decoded to its true source + provider +
 * reported pair, then matched against the market's intended `<ASSET> / USD`.
 */
export async function classifyExactlyOracles() {
    const config = readJsonFile(configFile);
    const marketsByChain = readJsonFile(marketsFile);
    const result = {};
    for (const [chainId, markets] of Object.entries(marketsByChain ?? {})) {
        const auditor = config?.[chainId]?.auditor;
        const rows = (markets ?? [])
            .map((m) => ({
            market: toAddr(m.market),
            asset: toAddr(m.asset),
            assetSymbol: m.assetSymbol ?? null,
        }))
            .filter((m) => isAddr(m.market) && isAddr(m.asset));
        if (!rows.length || !isAddr(auditor))
            continue;
        console.log(`Exactly oracles [${chainId}]: ${rows.length} markets`);
        // 1. per-market price feed from the Auditor.
        const feedRes = (await multicallRetryUniversal({
            chain: chainId,
            calls: rows.map((m) => ({
                address: auditor,
                name: "markets",
                args: [m.market],
            })),
            abi: AUDITOR_ABI,
            allowFailure: true,
            maxRetries: 4,
        }).catch(() => []));
        const feedByMarket = new Map();
        rows.forEach((m, i) => {
            const r = feedRes[i];
            const feed = Array.isArray(r) ? toAddr(r[4]) : toAddr(r?.priceFeed);
            feedByMarket.set(m.market, feed);
        });
        // 2. on-chain symbols (fallback to metadata assetSymbol).
        const tokens = [...new Set(rows.map((m) => m.asset))];
        const symRes = (await multicallRetryUniversal({
            chain: chainId,
            calls: tokens.map((t) => ({ address: t, name: "symbol", args: [] })),
            abi: SYMBOL_ABI,
            allowFailure: true,
            maxRetries: 8,
        }).catch(() => []));
        const symbolByToken = new Map();
        tokens.forEach((t, i) => symbolByToken.set(t, asString(symRes[i])));
        // 3. probe + resolve the unique feeds.
        const feeds = [
            ...new Set([...feedByMarket.values()].filter(isAddr)),
        ];
        const graph = feeds.length ? await probeFeedGraph(chainId, feeds) : new Map();
        const resolvedByFeed = new Map(feeds.map((f) => [f, resolveFeed(f, graph)]));
        result[chainId] = {};
        for (const m of rows) {
            const feed = feedByMarket.get(m.market) ?? null;
            const resolved = feed && isAddr(feed) ? resolvedByFeed.get(feed) ?? null : null;
            const assetSymbol = symbolByToken.get(m.asset) ?? m.assetSymbol ?? null;
            const a = resolved
                ? assessFeed(resolved, assetSymbol, "USD")
                : {
                    denominator: null,
                    intendedPair: assetSymbol ? `${assetSymbol} / USD` : null,
                    correctOracle: null,
                    denominatorMatch: null,
                };
            result[chainId][m.market.toLowerCase()] = {
                market: m.market,
                asset: m.asset,
                assetSymbol,
                oracle: feed && isAddr(feed) ? feed : null,
                source: feed && isAddr(feed) ? feed : null,
                rawDescription: resolved?.rawDescription ?? null,
                priceDescription: resolved?.priceDescription ?? "UNKNOWN",
                provider: resolved?.provider ?? "exactly-oracle",
                fixedRate: resolved?.fixedRate ?? null,
                underlyingAggregator: resolved?.underlyingAggregator ?? null,
                sourcePath: resolved?.sourcePath ?? [],
                denominator: a.denominator,
                intendedPair: a.intendedPair,
                correctOracle: a.correctOracle,
                denominatorMatch: a.denominatorMatch,
            };
        }
    }
    return result;
}
