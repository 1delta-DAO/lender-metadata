import { multicallRetryUniversal } from "@1delta/providers";
import { POINTER_SELECTORS, PROBE_ABI } from "./abi.js";
import { asNumber, asString, decodeBytes32String, normalizeDescription, parsePair, synthesizeFromPairs, toAddr, } from "./normalize.js";
const FORWARD_SELECTORS = [
    "aggregator",
    "underlyingPriceFeed",
    "priceFeed",
    "currentOracle",
];
/**
 * Probes a set of oracle/feed addresses and walks their source graph (bounded BFS)
 * by following every pointer selector. Returns a map of address -> FeedNode for
 * every node discovered, including transitive underlying feeds.
 */
export async function probeFeedGraph(chainId, entryPoints, { maxDepth = 4 } = {}) {
    const nodes = new Map();
    let frontier = [...new Set(entryPoints.map((a) => a.toLowerCase()))].filter((a) => toAddr(a) !== null);
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
        const calls = frontier.flatMap((address) => [
            ...POINTER_SELECTORS.map((name) => ({ address, name, args: [] })),
            { address, name: "description", args: [] },
            { address, name: "decimals", args: [] },
            { address, name: "getDataFeedId", args: [] },
        ]);
        const results = (await multicallRetryUniversal({
            chain: chainId,
            calls,
            abi: PROBE_ABI,
            allowFailure: true,
            maxRetries: 12,
        }));
        const stride = POINTER_SELECTORS.length + 3;
        const next = new Set();
        frontier.forEach((address, i) => {
            const slice = results.slice(i * stride, i * stride + stride);
            const pointers = {};
            POINTER_SELECTORS.forEach((sel, j) => {
                const addr = toAddr(slice[j]);
                if (addr && addr !== address)
                    pointers[sel] = addr;
            });
            const rawDescription = asString(slice[POINTER_SELECTORS.length]);
            const decimals = asNumber(slice[POINTER_SELECTORS.length + 1]);
            const dataFeedId = decodeBytes32String(slice[POINTER_SELECTORS.length + 2]);
            nodes.set(address, {
                address,
                rawDescription,
                description: rawDescription ? normalizeDescription(rawDescription) : null,
                decimals,
                dataFeedId,
                pointers,
            });
            for (const addr of Object.values(pointers)) {
                if (!nodes.has(addr))
                    next.add(addr);
            }
        });
        frontier = [...next];
    }
    return nodes;
}
function classifyNode(node) {
    if (!node)
        return "unknown";
    const desc = node.rawDescription ?? "";
    if (node.dataFeedId || /redstone/i.test(desc))
        return "redstone";
    if (node.pointers.BASE_FEED_1 || node.pointers.QUOTE_FEED_1)
        return "morpho-composite";
    if (node.pointers.priceFeedA || node.pointers.priceFeedB)
        return "composite";
    if (/constant/i.test(desc))
        return "constant";
    if (/exchange\s*rate/i.test(desc))
        return "exchange-rate";
    // Pendle Principal Token price-cap adapters: "PT Capped <underlying> <feed>
    // linear discount <date>". They wrap a numeraire feed (e.g. USDT/USD) with a
    // time-decay discount to price the PT itself, so the terminal feed's asset is
    // the numeraire — not the priced asset. Must be detected before the generic
    // `aggregator -> chainlink` fallthrough below, since they expose an aggregator.
    if (/\bpt\b/i.test(desc) && /(linear\s+discount|capped)/i.test(desc))
        return "pendle-pt";
    // Aave PriceCapAdapter / PriceCapAdapterStable: "Capped <asset> / <num>" — a
    // (possibly correlated) reference feed bounded by an upper cap. Same-asset caps
    // resolve to the asset's own pair (correct); cross-asset caps (e.g. USDe via
    // "Capped USDT/USD") are deliberate correlated proxies, scored separately.
    // Checked after the PT case, since PT adapters read "PT Capped …".
    if (/^capped\b/i.test(desc))
        return "price-cap";
    if (/^custom price feed/i.test(desc) || /^price feed for/i.test(desc))
        return "compound-wrapper";
    if (node.pointers.aggregator)
        return "chainlink";
    // Plain "A / B" feed with 8 decimals is overwhelmingly a Chainlink aggregator.
    if (node.description && node.description.includes(" / ") && node.decimals === 8)
        return "chainlink";
    return "unknown";
}
/**
 * Resolves a single entry-point feed into a normalized pair + provider + source path,
 * walking the previously-probed graph. Memoize across calls via the shared `seen` set
 * to guard against cycles.
 */
export function resolveFeed(entry, nodes) {
    const path = [];
    const seen = new Set();
    let underlyingAggregator = null;
    const resolvePair = (addr, guard) => {
        const node = nodes.get(addr);
        if (!node || guard.has(addr))
            return null;
        guard.add(addr);
        // 1. node itself reports a clean pair
        const ownPair = parsePair(node.description);
        if (ownPair)
            return `${ownPair.base} / ${ownPair.quote}`;
        // 2. composite multiplicative feed: combine A and B
        if (node.pointers.priceFeedA || node.pointers.priceFeedB) {
            const parts = [node.pointers.priceFeedA, node.pointers.priceFeedB]
                .filter((a) => !!a)
                .map((a) => parsePair(resolvePair(a, guard)));
            const synth = synthesizeFromPairs(parts);
            if (synth)
                return synth;
        }
        // 3. Morpho-style composite
        if (node.pointers.BASE_FEED_1 || node.pointers.QUOTE_FEED_1) {
            const basePairs = [node.pointers.BASE_FEED_1, node.pointers.BASE_FEED_2]
                .filter((a) => !!a)
                .map((a) => parsePair(resolvePair(a, guard)));
            const quotePairs = [node.pointers.QUOTE_FEED_1, node.pointers.QUOTE_FEED_2]
                .filter((a) => !!a)
                .map((a) => parsePair(resolvePair(a, guard)))
                // quote feeds are inverted in the price formula
                .map((p) => (p ? { base: p.quote, quote: p.base } : null));
            const synth = synthesizeFromPairs([...basePairs, ...quotePairs]);
            if (synth)
                return synth;
        }
        // 4. single forward pointer (wrapper / proxy / scaling feed)
        for (const sel of FORWARD_SELECTORS) {
            const target = node.pointers[sel];
            if (target) {
                const sub = resolvePair(target, guard);
                if (sub)
                    return sub;
            }
        }
        // 5. RedStone data feed id
        if (node.dataFeedId)
            return `${node.dataFeedId} / USD`;
        return null;
    };
    // Build the source path (single forward chain, recording aggregators).
    let cursor = entry;
    while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const node = nodes.get(cursor);
        if (!node)
            break;
        const kind = classifyNode(node);
        path.push({
            address: cursor,
            description: node.description,
            decimals: node.decimals,
            kind,
        });
        if (node.pointers.aggregator)
            underlyingAggregator = node.pointers.aggregator;
        const nextAddr = FORWARD_SELECTORS.map((s) => node.pointers[s]).find((a) => !!a);
        cursor = nextAddr ?? null;
    }
    const entryNode = nodes.get(entry);
    const provider = classifyNode(entryNode);
    const priceDescription = resolvePair(entry, new Set()) ?? "UNKNOWN";
    // fixed-rate requires a POSITIVE signal: the feed's description says it's
    // constant (provider === "constant"). We do NOT infer fixed-rate from the mere
    // absence of a description/pointers — many custom oracles (Venus OneJump, fork
    // PT/exotic feeds, even live WETH feeds) answer `decimals()` but expose no
    // description, and guessing "fixed-rate" there produces false HIGH scores.
    // Such undecodable feeds are left as their resolved provider/UNKNOWN instead.
    const fixedRate = provider === "constant" ? true : null;
    return {
        priceDescription,
        rawDescription: entryNode?.rawDescription ?? null,
        provider,
        fixedRate,
        underlyingAggregator,
        sourcePath: path,
    };
}
