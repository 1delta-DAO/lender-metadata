import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import { probeFeedGraph, resolveFeed } from "../oracle-classifier/feedResolver.js";
import { asString, symbolsMatch, toAddr } from "../oracle-classifier/normalize.js";
import { assessFeed } from "../oracle-classifier/assess.js";
const oraclesFile = "./data/compound-v2-oracles.json"; // fork -> chain -> PriceOracle address
const cTokensFile = "./data/compound-v2-c-tokens.json"; // fork -> chain -> underlying -> cToken
const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;
// Per-asset feed getters across the Compound-V2 oracle implementations we've seen:
//  - Venus ResilientOracle: getTokenConfig(token).oracles[0] → a ChainlinkOracle
//    whose tokenConfigs(token).feed is the Chainlink aggregator. (VENUS*, ENCLABS, SEGMENT)
//  - Moonwell ChainlinkOracle: getFeed(symbol) → aggregator directly.
// Forks whose oracle exposes neither are left undecoded (priceDescription UNKNOWN,
// correctOracle null) — never guessed.
const RESILIENT_ABI = [
    { name: "getTokenConfig", stateMutability: "view", type: "function", inputs: [{ type: "address" }], outputs: [
            { type: "tuple", components: [
                    { name: "asset", type: "address" },
                    { name: "oracles", type: "address[3]" },
                    { name: "enableFlagsForOracles", type: "bool[3]" },
                ] }
        ] },
];
const CHAINLINK_ORACLE_ABI = [
    { name: "tokenConfigs", stateMutability: "view", type: "function", inputs: [{ type: "address" }], outputs: [
            { type: "tuple", components: [
                    { name: "asset", type: "address" },
                    { name: "feed", type: "address" },
                    { name: "maxStalePeriod", type: "uint256" },
                ] }
        ] },
];
const GET_FEED_ABI = [
    { name: "getFeed", stateMutability: "view", type: "function", inputs: [{ type: "string" }], outputs: [{ type: "address" }] },
];
// Venus CorrelatedTokenOracle / OneJumpOracle: prices a correlated token (e.g.
// SolvBTC) via an underlying token (BTCB) through a resilient oracle + an
// exchange rate. It exposes no Chainlink getters, so the generic probe would
// mislabel it — detect it explicitly and classify as exchange-rate.
const CORRELATED_ABI = [
    { name: "CORRELATED_TOKEN", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "address" }] },
    { name: "UNDERLYING_TOKEN", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "address" }] },
    { name: "RESILIENT_ORACLE", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "address" }] },
];
// Kinetic (Flare) ProtocolFTSOV3Oracle / OverridablePriceOracle: getPrice(asset)
// returns an owner-posted assetPrices(asset) when set, else the Flare FTSOv2 feed
// tokenConfigs(asset).ftsoV2FeedId (bytes21: category byte ‖ ASCII "XRP/USD"),
// times exchangeAsset.getExchangeRate() when one is configured (sFLR). FTSO feeds
// are not contracts, so there is no feed address to probe — decode the id itself.
const KINETIC_FTSO_ABI = [
    { name: "ftsoV2", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "address" }] },
    { name: "assetPrices", stateMutability: "view", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
    { name: "tokenConfigs", stateMutability: "view", type: "function", inputs: [{ type: "address" }], outputs: [
            { name: "asset", type: "address" },
            { name: "ftsoV2FeedId", type: "bytes21" },
            { name: "maxStalePeriod", type: "uint64" },
            { name: "exchangeAsset", type: "address" },
        ] },
];
/** FTSOv2 feed id → "XRP / USD"; null when it is not a printable BASE/QUOTE name. */
function ftsoPair(id) {
    if (typeof id !== "string" || !/^0x[0-9a-fA-F]{42}$/.test(id))
        return null;
    const name = Buffer.from(id.slice(4), "hex").toString("latin1").replace(/\0+$/, "");
    const m = name.match(/^([A-Za-z0-9.]+)\/([A-Za-z0-9.]+)$/);
    return m ? `${m[1]} / ${m[2]}` : null;
}
// Native markets (vBNB, cETH, qiAVAX, …) have no ERC-20 underlying: c-tokens maps
// them from the zero address. Venus' ResilientOracle keys the native coin by this
// sentinel (`NATIVE_TOKEN_ADDR`, BSC vBNB → Chainlink BNB/USD), so it is the address
// probed for the feed. Forks that answer by symbol (Moonwell getFeed) get the
// native symbol, derived from the market's own cToken symbol (see nativeSymbols).
// Skipping them used to leave the native market — Venus BNB alone held ~$440M on
// 2026-10-03 — with no oracle row, hence no governance or tier row downstream.
const NATIVE_SENTINEL = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/**
 * The native coin's symbol per cToken, read off the market itself: a fork names
 * its markets `<prefix><underlyingSymbol>` (vUSDT, cDAI, qiUSDC), so the prefix is
 * learned from the fork's ERC-20 markets on the chain and stripped from the native
 * market's symbol (vBNB → BNB). No agreed prefix → null (left unverified, never guessed).
 */
async function nativeSymbols(chainId, items, symbolByAsset) {
    const out = new Map();
    const natives = items.filter((i) => i.native);
    if (natives.length === 0)
        return out;
    const forks = new Set(natives.map((n) => n.fork));
    const sample = items.filter((i) => forks.has(i.fork));
    const res = (await multicallRetryUniversal({
        chain: chainId,
        calls: sample.map((i) => ({ address: i.cToken, name: "symbol", args: [] })),
        abi: SYMBOL_ABI,
        allowFailure: true,
        maxRetries: 6,
    }).catch(() => []));
    const cSym = new Map();
    sample.forEach((i, k) => cSym.set(i.cToken, asString(res[k])));
    for (const fork of forks) {
        const votes = new Map();
        for (const i of sample) {
            if (i.fork !== fork || i.native)
                continue;
            const c = cSym.get(i.cToken);
            const u = symbolByAsset.get(i.asset);
            if (!c || !u || !c.endsWith(u) || c.length === u.length)
                continue;
            const pre = c.slice(0, c.length - u.length);
            votes.set(pre, (votes.get(pre) ?? 0) + 1);
        }
        const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        for (const n of natives) {
            if (n.fork !== fork)
                continue;
            const c = cSym.get(n.cToken);
            out.set(n.cToken, best && c && c.startsWith(best) && c.length > best.length ? c.slice(best.length) : null);
        }
    }
    return out;
}
/** Resolve per-asset feed addresses for one fork oracle, trying each known strategy. */
async function extractFeeds(chainId, oracle, assets, symbolByAsset) {
    const feedByAsset = new Map();
    // Strategy 0: Kinetic ProtocolFTSOV3Oracle (ftsoV2() + tokenConfigs(asset)).
    const ftso = (await multicallRetryUniversal({
        chain: chainId,
        calls: [{ address: oracle, name: "ftsoV2", args: [] }],
        abi: KINETIC_FTSO_ABI,
        allowFailure: true,
        maxRetries: 3,
    }).catch(() => []));
    if (isAddr(toAddr(ftso[0]))) {
        // The native market's override (`etherPrice`) has no getter: leave it undecoded.
        const erc20 = assets.filter((a) => a !== NATIVE_SENTINEL);
        const res = (await multicallRetryUniversal({
            chain: chainId,
            calls: erc20.flatMap((a) => [
                { address: oracle, name: "tokenConfigs", args: [a] },
                { address: oracle, name: "assetPrices", args: [a] },
            ]),
            abi: KINETIC_FTSO_ABI,
            allowFailure: true,
            maxRetries: 3,
        }).catch(() => []));
        const ftsoByAsset = new Map();
        erc20.forEach((a, i) => {
            const cfg = res[2 * i];
            const override = res[2 * i + 1];
            if (!Array.isArray(cfg) || typeof override !== "bigint")
                return; // unread: stays UNKNOWN
            if (!cfg[2] || BigInt(cfg[2]) === 0n)
                return; // not configured: getPrice reverts
            ftsoByAsset.set(a, {
                pair: ftsoPair(cfg[1]),
                feedId: String(cfg[1]),
                maxStale: String(cfg[2]),
                exchangeAsset: isAddr(toAddr(cfg[3])) ? toAddr(cfg[3]) : null,
                override: override > 0n ? override.toString() : null,
            });
        });
        return { provider: "ftso", feedByAsset, ftsoByAsset };
    }
    // Strategy A: Venus ResilientOracle → inner ChainlinkOracle → tokenConfigs(asset).feed
    const cfgs = (await multicallRetryUniversal({
        chain: chainId,
        calls: assets.map((a) => ({ address: oracle, name: "getTokenConfig", args: [a] })),
        abi: RESILIENT_ABI,
        allowFailure: true,
        maxRetries: 3,
    }).catch(() => []));
    const innerByAsset = new Map();
    assets.forEach((a, i) => {
        const inner = toAddr(cfgs[i]?.oracles?.[0]);
        if (inner && isAddr(inner))
            innerByAsset.set(a, inner);
    });
    if (innerByAsset.size > 0) {
        const entries = [...innerByAsset.entries()];
        const feeds = (await multicallRetryUniversal({
            chain: chainId,
            calls: entries.map(([a, inner]) => ({ address: inner, name: "tokenConfigs", args: [a] })),
            abi: CHAINLINK_ORACLE_ABI,
            allowFailure: true,
            maxRetries: 3,
        }).catch(() => []));
        entries.forEach(([a], i) => {
            const feed = toAddr(feeds[i]?.feed);
            // Fall back to the inner oracle itself when it isn't a plain ChainlinkOracle
            // (e.g. Venus PT/correlated oracles) — probing it may still yield a pair.
            feedByAsset.set(a, isAddr(feed) ? feed : innerByAsset.get(a));
        });
        if ([...feedByAsset.values()].some(isAddr))
            return { provider: "chainlink", feedByAsset };
    }
    // Strategy B: Moonwell ChainlinkOracle → getFeed(symbol)
    const withSym = assets.filter((a) => symbolByAsset.get(a));
    if (withSym.length > 0) {
        const feeds = (await multicallRetryUniversal({
            chain: chainId,
            calls: withSym.map((a) => ({ address: oracle, name: "getFeed", args: [symbolByAsset.get(a)] })),
            abi: GET_FEED_ABI,
            allowFailure: true,
            maxRetries: 3,
        }).catch(() => []));
        let any = false;
        withSym.forEach((a, i) => {
            const feed = toAddr(feeds[i]);
            if (isAddr(feed)) {
                feedByAsset.set(a, feed);
                any = true;
            }
        });
        if (any)
            return { provider: "chainlink", feedByAsset };
    }
    // Undecoded oracle implementation — leave feeds null.
    return { provider: "compound-v2-oracle", feedByAsset };
}
export async function classifyCompoundV2Oracles() {
    const oracles = readJsonFile(oraclesFile);
    const cTokens = readJsonFile(cTokensFile);
    // Group every (fork, oracle, asset, cToken) by chain for batched probing.
    const itemsByChain = new Map();
    for (const [fork, byChain] of Object.entries(oracles)) {
        for (const [chainId, oracle] of Object.entries(byChain)) {
            if (!isAddr(oracle))
                continue;
            const cmap = cTokens[fork]?.[chainId] ?? {};
            for (const [underlying, cToken] of Object.entries(cmap)) {
                if (!isAddr(cToken))
                    continue;
                // toAddr() maps the zero address to null, so test the raw key for native.
                const native = typeof underlying === "string" && underlying.toLowerCase() === ZERO;
                const raw = native ? ZERO : toAddr(underlying);
                const asset = native ? NATIVE_SENTINEL : raw;
                if (!asset || !isAddr(asset))
                    continue;
                if (!itemsByChain.has(chainId))
                    itemsByChain.set(chainId, []);
                itemsByChain.get(chainId).push({ fork, oracle: oracle.toLowerCase(), asset, cToken: cToken.toLowerCase(), native });
            }
        }
    }
    const result = {};
    for (const [chainId, items] of itemsByChain.entries()) {
        const assets = [...new Set(items.map((i) => i.asset))];
        console.log(`Compound v2 oracles [${chainId}]: ${items.length} markets, ${assets.length} assets`);
        // Resolve asset symbols (needed for Moonwell getFeed + assess).
        const symResults = (await multicallRetryUniversal({
            chain: chainId,
            calls: assets.map((a) => ({ address: a, name: "symbol", args: [] })),
            abi: SYMBOL_ABI,
            allowFailure: true,
            maxRetries: 12,
        }).catch(() => []));
        const symbolByAsset = new Map();
        assets.forEach((a, i) => symbolByAsset.set(a, asString(symResults[i])));
        // Native markets: the sentinel has no symbol(); take it from the cToken.
        const nativeSym = await nativeSymbols(chainId, items, symbolByAsset);
        const nat = [...nativeSym.values()].find((v) => !!v) ?? null;
        if (nat)
            symbolByAsset.set(NATIVE_SENTINEL, nat);
        // Per (fork, oracle): extract per-asset feeds with the right strategy.
        const byOracle = new Map();
        for (const it of items) {
            const key = `${it.fork}|${it.oracle}`;
            if (!byOracle.has(key))
                byOracle.set(key, []);
            byOracle.get(key).push(it);
        }
        const feedOf = new Map(); // `${fork}|${asset}` -> feed
        const ftsoOf = new Map(); // `${fork}|${asset}` -> Kinetic FTSO config
        const providerOfOracle = new Map();
        for (const [key, group] of byOracle.entries()) {
            const [fork, oracle] = key.split("|");
            const groupAssets = [...new Set(group.map((g) => g.asset))];
            const { provider, feedByAsset, ftsoByAsset } = await extractFeeds(chainId, oracle, groupAssets, symbolByAsset);
            providerOfOracle.set(key, provider);
            for (const a of groupAssets)
                feedOf.set(`${fork}|${a}`, feedByAsset.get(a) ?? null);
            for (const [a, c] of ftsoByAsset ?? [])
                ftsoOf.set(`${fork}|${a}`, c);
        }
        const candidateFeeds = [...new Set([...feedOf.values()].filter(isAddr))];
        // Detect Venus CorrelatedTokenOracle/OneJumpOracle among the candidate feeds.
        // These price the correlated token (the market asset) via an underlying token
        // + exchange rate, so they're a live exchange-rate oracle — not a plain feed.
        const corrRes = candidateFeeds.length
            ? (await multicallRetryUniversal({
                chain: chainId,
                calls: candidateFeeds.flatMap((f) => [
                    { address: f, name: "CORRELATED_TOKEN", args: [] },
                    { address: f, name: "UNDERLYING_TOKEN", args: [] },
                ]),
                abi: CORRELATED_ABI,
                allowFailure: true,
                maxRetries: 3,
            }).catch(() => []))
            : [];
        const correlated = new Map();
        candidateFeeds.forEach((f, i) => {
            const corr = toAddr(corrRes[2 * i]);
            const under = toAddr(corrRes[2 * i + 1]);
            if (isAddr(under))
                correlated.set(f, { corr, under });
        });
        // Resolve underlying-token symbols for a transparent priceDescription.
        const underTokens = [...new Set([...correlated.values()].map((c) => c.under).filter(isAddr))];
        const underSymRes = underTokens.length
            ? (await multicallRetryUniversal({
                chain: chainId, calls: underTokens.map((t) => ({ address: t, name: "symbol", args: [] })),
                abi: SYMBOL_ABI, allowFailure: true, maxRetries: 6,
            }).catch(() => []))
            : [];
        const underSymOf = new Map();
        underTokens.forEach((t, i) => underSymOf.set(t, asString(underSymRes[i])));
        // Probe only the plain (non-correlated) feeds through the source graph.
        const feeds = candidateFeeds.filter((f) => !correlated.has(f));
        const graph = feeds.length ? await probeFeedGraph(chainId, feeds) : new Map();
        const resolvedByFeed = new Map(feeds.map((f) => [f, resolveFeed(f, graph)]));
        for (const it of items) {
            const feed = feedOf.get(`${it.fork}|${it.asset}`) ?? null;
            const assetSymbol = it.native ? nativeSym.get(it.cToken) ?? null : symbolByAsset.get(it.asset) ?? null;
            // Published `asset` stays the c-tokens convention (zero address = native coin).
            const outAsset = it.native ? ZERO : it.asset;
            if (!result[it.fork])
                result[it.fork] = {};
            if (!result[it.fork][chainId])
                result[it.fork][chainId] = {};
            const ftsoCfg = ftsoOf.get(`${it.fork}|${it.asset}`);
            if (ftsoCfg) {
                const intendedPair = assetSymbol ? `${assetSymbol} / USD` : null;
                const base = {
                    cToken: it.cToken, asset: outAsset, assetSymbol, oracle: it.oracle, source: null, underlyingAggregator: null, intendedPair,
                };
                if (ftsoCfg.override) {
                    // Owner-posted price: a fixed number until the owner changes it.
                    result[it.fork][chainId][it.cToken] = {
                        ...base, rawDescription: `owner-posted price ${ftsoCfg.override} (ProtocolFTSOV3Oracle assetPrices override)`,
                        priceDescription: intendedPair ?? "UNKNOWN", provider: "constant", fixedRate: true,
                        sourcePath: [{ address: it.oracle, description: "assetPrices override", decimals: null, kind: "constant" }],
                        denominator: "USD", correctOracle: null, denominatorMatch: null,
                    };
                    continue;
                }
                if (ftsoCfg.pair) {
                    const [fb, fq] = ftsoCfg.pair.split(" / ");
                    // With an exchangeAsset the feed prices the underlying of a rate (FLR for sFLR):
                    // the market asset is then priced via that rate, as assetSymbol / USD.
                    const priced = ftsoCfg.exchangeAsset ? assetSymbol : fb;
                    const priceDescription = priced ? `${priced} / ${fq}` : "UNKNOWN";
                    result[it.fork][chainId][it.cToken] = {
                        ...base,
                        rawDescription: ftsoCfg.exchangeAsset
                            ? `${assetSymbol} / ${fb} exchange rate (${ftsoCfg.exchangeAsset}.getExchangeRate()) * ${ftsoCfg.pair} (FTSOv2 ${ftsoCfg.feedId})`
                            : `${ftsoCfg.pair} (FTSOv2 ${ftsoCfg.feedId}, max stale ${ftsoCfg.maxStale}s)`,
                        priceDescription,
                        provider: ftsoCfg.exchangeAsset ? "exchange-rate" : "ftso",
                        fixedRate: null,
                        sourcePath: [{ address: ftsoCfg.feedId, description: ftsoCfg.pair, decimals: null, kind: "ftso" }],
                        denominator: fq,
                        correctOracle: assetSymbol && priced ? symbolsMatch(priced, assetSymbol) : null,
                        denominatorMatch: symbolsMatch(fq, "USD"),
                    };
                    continue;
                }
            }
            const corr = feed && isAddr(feed) ? correlated.get(feed) : undefined;
            if (corr && feed) {
                // Exchange-rate (correlated-token) oracle. It's purpose-built for this
                // asset (CORRELATED_TOKEN == asset) and applies the asset's redemption
                // rate against the underlying's USD price → correct, not fixed-rate.
                const underSym = corr.under ? underSymOf.get(corr.under) ?? null : null;
                const forAsset = corr.corr ? corr.corr.toLowerCase() === it.asset : false;
                result[it.fork][chainId][it.cToken] = {
                    cToken: it.cToken, asset: outAsset, assetSymbol,
                    oracle: it.oracle, source: feed,
                    rawDescription: underSym ? `Correlated price via ${underSym}` : "Correlated-token oracle",
                    priceDescription: assetSymbol ? `${assetSymbol} / USD` : "UNKNOWN",
                    provider: "exchange-rate",
                    fixedRate: null,
                    underlyingAggregator: null,
                    sourcePath: [{ address: feed, description: underSym ? `via ${underSym}` : null, decimals: null, kind: "exchange-rate" }],
                    denominator: "USD",
                    intendedPair: assetSymbol ? `${assetSymbol} / USD` : null,
                    correctOracle: forAsset && assetSymbol ? true : null,
                    denominatorMatch: true,
                };
                continue;
            }
            const resolved = feed && isAddr(feed) ? resolvedByFeed.get(feed) ?? null : null;
            // Compound V2 oracles price in USD (getUnderlyingPrice is USD-scaled).
            const a = resolved
                ? assessFeed(resolved, assetSymbol, "USD")
                : { denominator: null, intendedPair: assetSymbol ? `${assetSymbol} / USD` : null, correctOracle: null, denominatorMatch: null };
            result[it.fork][chainId][it.cToken] = {
                cToken: it.cToken,
                asset: outAsset,
                assetSymbol,
                oracle: it.oracle,
                source: feed && isAddr(feed) ? feed : null,
                rawDescription: resolved?.rawDescription ?? null,
                priceDescription: resolved?.priceDescription ?? "UNKNOWN",
                provider: resolved?.provider ?? providerOfOracle.get(`${it.fork}|${it.oracle}`) ?? "compound-v2-oracle",
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
