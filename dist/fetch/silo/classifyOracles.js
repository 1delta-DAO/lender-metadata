import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { SYMBOL_ABI } from "../oracle-classifier/abi.js";
import { probeFeedGraph, resolveFeed } from "../oracle-classifier/feedResolver.js";
import { asString, toAddr } from "../oracle-classifier/normalize.js";
import { assessFeed } from "../oracle-classifier/assess.js";
const siloV2File = "./data/silo-v2-markets.json";
const siloV3File = "./data/silo-v3-markets.json";
// Silo oracle adapters expose quoteToken() (the numeraire) and sometimes baseToken(),
// an inner oracle(), and a description()/name().
const SILO_ORACLE_ABI = [
    { inputs: [], name: "quoteToken", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "baseToken", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "oracle", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "description", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
];
// ISiloOracle.quote(baseAmount, baseToken) → value in the oracle's quoteToken.
// A non-zero answer proves the oracle is live and prices the silo's token in its
// numeraire (the Silo analog of Fluid's getExchangeRateOperate).
const SILO_QUOTE_ABI = [
    { inputs: [{ type: "uint256" }, { type: "address" }], name: "quote", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
];
function collectSides(markets, version, out) {
    for (const [chainId, list] of Object.entries(markets)) {
        for (const m of list ?? []) {
            for (const side of ["silo0", "silo1"]) {
                const s = m[side];
                const oracle = toAddr(s?.solvencyOracle);
                const silo = toAddr(s?.silo);
                const token = toAddr(s?.token);
                if (!oracle || !silo || !token)
                    continue;
                if (!out.has(chainId))
                    out.set(chainId, []);
                out.get(chainId).push({
                    market: m.name ?? silo,
                    silo,
                    side,
                    version,
                    token,
                    tokenSymbol: s?.symbol ?? null,
                    solvencyOracle: oracle,
                    maxLtvOracle: toAddr(s?.maxLtvOracle),
                });
            }
        }
    }
}
export async function classifySiloOracles() {
    const v2 = (() => {
        try {
            return readJsonFile(siloV2File);
        }
        catch {
            return {};
        }
    })();
    const v3 = (() => {
        try {
            return readJsonFile(siloV3File);
        }
        catch {
            return {};
        }
    })();
    const sidesByChain = new Map();
    collectSides(v2, "v2", sidesByChain);
    collectSides(v3, "v3", sidesByChain);
    const result = {};
    for (const [chainId, sides] of sidesByChain.entries()) {
        console.log(`Silo oracles [${chainId}]: ${sides.length} silos`);
        const oracles = [...new Set(sides.map((s) => s.solvencyOracle))];
        // 1. probe each solvency oracle for quoteToken / baseToken / inner oracle / description
        const probe = (await multicallRetryUniversal({
            chain: chainId,
            calls: oracles.flatMap((o) => [
                { address: o, name: "quoteToken", args: [] },
                { address: o, name: "baseToken", args: [] },
                { address: o, name: "oracle", args: [] },
                { address: o, name: "description", args: [] },
                { address: o, name: "name", args: [] },
            ]),
            abi: SILO_ORACLE_ABI,
            allowFailure: true,
            maxRetries: 12,
        }));
        const probeByOracle = new Map();
        oracles.forEach((o, i) => {
            probeByOracle.set(o, {
                quoteToken: toAddr(probe[5 * i]),
                inner: toAddr(probe[5 * i + 2]),
                description: asString(probe[5 * i + 3]),
                name: asString(probe[5 * i + 4]),
            });
        });
        // 2. decode the wrapped feed graph (the solvency oracle itself + any inner oracle)
        const feedEntries = [
            ...new Set(oracles.flatMap((o) => {
                const p = probeByOracle.get(o);
                return [o, p.inner].filter((x) => !!x);
            })),
        ];
        const feedGraph = await probeFeedGraph(chainId, feedEntries);
        // 3. resolve quoteToken symbols (token symbols come from the market metadata)
        const quoteTokens = [
            ...new Set([...probeByOracle.values()].map((p) => p.quoteToken).filter((q) => !!q)),
        ];
        const quoteSymbols = new Map();
        if (quoteTokens.length > 0) {
            const qres = (await multicallRetryUniversal({
                chain: chainId,
                calls: quoteTokens.map((q) => ({ address: q, name: "symbol", args: [] })),
                abi: SYMBOL_ABI,
                allowFailure: true,
                maxRetries: 12,
            }));
            quoteTokens.forEach((q, i) => quoteSymbols.set(q, asString(qres[i])));
        }
        // 3b. live-quote probe per side: ISiloOracle.quote(1e18, token) — non-zero
        // proves the oracle prices the silo's token in its numeraire, even when the
        // wrapped feed graph isn't introspectable.
        const liveRes = (await multicallRetryUniversal({
            chain: chainId,
            calls: sides.map((s) => ({ address: s.solvencyOracle, name: "quote", args: [10n ** 18n, s.token] })),
            abi: SILO_QUOTE_ABI,
            allowFailure: true,
            maxRetries: 6,
        }));
        const liveBySide = new Map();
        sides.forEach((s, i) => liveBySide.set(s, typeof liveRes[i] === "bigint" && liveRes[i] > 0n));
        result[chainId] = {};
        for (const s of sides) {
            const p = probeByOracle.get(s.solvencyOracle);
            const numeraire = p.quoteToken ? quoteSymbols.get(p.quoteToken) ?? null : null;
            // Prefer decoding the inner oracle, fall back to the solvency oracle itself.
            const feedEntry = p.inner ?? s.solvencyOracle;
            const resolved = resolveFeed(feedEntry, feedGraph);
            const provider = p.name ?? p.description ?? (resolved.provider !== "unknown" ? resolved.provider : "silo-oracle");
            const configuredPair = s.tokenSymbol && numeraire ? `${s.tokenSymbol} / ${numeraire}` : null;
            let { intendedPair, correctOracle, denominatorMatch } = assessFeed(resolved, s.tokenSymbol, numeraire);
            let priceDescription = resolved.priceDescription;
            // Level-1 fallback: the wrapped feed didn't decode, but a live quote proves
            // the oracle prices token→numeraire for exactly this silo's configured pair.
            if (priceDescription === "UNKNOWN" && liveBySide.get(s) && configuredPair) {
                priceDescription = configuredPair;
                correctOracle = true;
                denominatorMatch = true;
            }
            result[chainId][s.silo] = {
                market: s.market,
                silo: s.silo,
                side: s.side,
                version: s.version,
                token: s.token,
                tokenSymbol: s.tokenSymbol,
                solvencyOracle: s.solvencyOracle,
                maxLtvOracle: s.maxLtvOracle,
                sameOracle: s.maxLtvOracle === s.solvencyOracle,
                quoteToken: p.quoteToken,
                numeraire,
                innerOracle: p.inner,
                provider,
                priceDescription,
                underlyingAggregator: resolved.underlyingAggregator,
                sourcePath: resolved.sourcePath,
                configuredPair,
                intendedPair: intendedPair ?? configuredPair,
                correctOracle,
                denominatorMatch,
            };
        }
    }
    return result;
}
