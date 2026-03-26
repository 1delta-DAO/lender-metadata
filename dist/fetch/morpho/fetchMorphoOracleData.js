import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { MORPHO_CHAINLINK_ORACLE_V2_ABI, FEED_DESCRIPTION_ABI, } from "./oracleAbi.js";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const morphoOraclesFile = "./data/morpho-oracles.json";
const morphoTypeOraclesFile = "./data/morpho-type-oracles.json";
function isZeroAddress(addr) {
    return (!addr ||
        typeof addr !== "string" ||
        addr.toLowerCase() === ZERO_ADDRESS);
}
function synthesizePriceDescription(b1, b2, q1, q2) {
    const parse = (desc) => {
        if (!desc)
            return null;
        const parts = desc.split(" / ");
        if (parts.length < 2)
            return null;
        return { base: parts[0].trim() };
    };
    const baseTokens = [parse(b1), parse(b2)]
        .filter(Boolean)
        .map((p) => p.base);
    const quoteTokens = [parse(q1), parse(q2)]
        .filter(Boolean)
        .map((p) => p.base);
    if (baseTokens.length === 0 && quoteTokens.length === 0)
        return "UNKNOWN";
    const numerator = baseTokens.join(" * ") || "1";
    const denominator = quoteTokens.join(" * ") || "1";
    return `${numerator} / ${denominator}`;
}
export async function fetchMorphoOracleData() {
    const [morphoOracles, morphoTypeOracles] = await Promise.all([
        readJsonFile(morphoOraclesFile),
        readJsonFile(morphoTypeOraclesFile),
    ]);
    // Collect unique oracle addresses per chain from both sources
    const oraclesPerChain = {};
    // morpho-oracles.json: { [chainId]: Array<{ oracle }> }
    for (const [chainId, entries] of Object.entries(morphoOracles)) {
        if (!oraclesPerChain[chainId])
            oraclesPerChain[chainId] = new Set();
        for (const entry of entries) {
            if (!isZeroAddress(entry.oracle)) {
                oraclesPerChain[chainId].add(entry.oracle.toLowerCase());
            }
        }
    }
    // morpho-type-oracles.json: { [chainId]: { [fork]: Array<{ oracle }> } }
    for (const [chainId, forks] of Object.entries(morphoTypeOracles)) {
        if (!oraclesPerChain[chainId])
            oraclesPerChain[chainId] = new Set();
        for (const entries of Object.values(forks)) {
            for (const entry of entries) {
                if (!isZeroAddress(entry.oracle)) {
                    oraclesPerChain[chainId].add(entry.oracle.toLowerCase());
                }
            }
        }
    }
    const result = {};
    for (const [chainId, oracleSet] of Object.entries(oraclesPerChain)) {
        const oracles = Array.from(oracleSet);
        if (oracles.length === 0)
            continue;
        console.log(`Morpho oracles: fetching ${oracles.length} oracle configs on chain ${chainId}`);
        // Batch 1: BASE_FEED_1, BASE_FEED_2, QUOTE_FEED_1, QUOTE_FEED_2 for all oracles
        const oracleConfigCalls = oracles.flatMap((oracle) => [
            { address: oracle, name: "BASE_FEED_1", args: [] },
            { address: oracle, name: "BASE_FEED_2", args: [] },
            { address: oracle, name: "QUOTE_FEED_1", args: [] },
            { address: oracle, name: "QUOTE_FEED_2", args: [] },
        ]);
        const oracleConfigResults = (await multicallRetryUniversal({
            chain: chainId,
            calls: oracleConfigCalls,
            abi: MORPHO_CHAINLINK_ORACLE_V2_ABI,
            allowFailure: true,
            maxRetries: 12,
        }));
        const oracleConfigs = {};
        for (let i = 0; i < oracles.length; i++) {
            const slice = oracleConfigResults.slice(4 * i, 4 * i + 4);
            const toAddr = (v) => !isZeroAddress(v) ? v.toLowerCase() : null;
            oracleConfigs[oracles[i]] = {
                baseFeed1: toAddr(slice[0]),
                baseFeed2: toAddr(slice[1]),
                quoteFeed1: toAddr(slice[2]),
                quoteFeed2: toAddr(slice[3]),
            };
        }
        // Collect unique non-null feed addresses
        const feedSet = new Set();
        for (const config of Object.values(oracleConfigs)) {
            if (config.baseFeed1)
                feedSet.add(config.baseFeed1);
            if (config.baseFeed2)
                feedSet.add(config.baseFeed2);
            if (config.quoteFeed1)
                feedSet.add(config.quoteFeed1);
            if (config.quoteFeed2)
                feedSet.add(config.quoteFeed2);
        }
        const feeds = Array.from(feedSet);
        const feedDescriptions = {};
        if (feeds.length > 0) {
            console.log(`Morpho oracles: fetching ${feeds.length} feed descriptions on chain ${chainId}`);
            // Batch 2: description() for all unique feeds
            const descCalls = feeds.map((feed) => ({
                address: feed,
                name: "description",
                args: [],
            }));
            const descResults = (await multicallRetryUniversal({
                chain: chainId,
                calls: descCalls,
                abi: FEED_DESCRIPTION_ABI,
                allowFailure: true,
                maxRetries: 12,
            }));
            feeds.forEach((feed, i) => {
                const raw = descResults[i];
                feedDescriptions[feed] = typeof raw === "string" ? raw : null;
            });
        }
        // Build result for this chain
        result[chainId] = {};
        for (const oracle of oracles) {
            const config = oracleConfigs[oracle];
            const b1Desc = config.baseFeed1
                ? (feedDescriptions[config.baseFeed1] ?? null)
                : null;
            const b2Desc = config.baseFeed2
                ? (feedDescriptions[config.baseFeed2] ?? null)
                : null;
            const q1Desc = config.quoteFeed1
                ? (feedDescriptions[config.quoteFeed1] ?? null)
                : null;
            const q2Desc = config.quoteFeed2
                ? (feedDescriptions[config.quoteFeed2] ?? null)
                : null;
            result[chainId][oracle] = {
                baseFeed1: config.baseFeed1,
                baseFeed2: config.baseFeed2,
                quoteFeed1: config.quoteFeed1,
                quoteFeed2: config.quoteFeed2,
                baseFeed1Description: b1Desc,
                baseFeed2Description: b2Desc,
                quoteFeed1Description: q1Desc,
                quoteFeed2Description: q2Desc,
                priceDescription: synthesizePriceDescription(b1Desc, b2Desc, q1Desc, q2Desc),
            };
        }
    }
    return result;
}
