import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { toAddr } from "../oracle-classifier/normalize.js";
// data/teller-pools.json: chain -> [{ pool, principal, collateral, symbols... }]
const poolsFile = "./data/teller-pools.json";
const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;
/**
 * Teller pool oracle ABIs. Unlike every Chainlink-based lender, Teller pools
 * price collateral↔principal via a DEX oracle:
 *  - V2 (`LenderCommitmentGroup_Pool_V2`): a Uniswap-V3 TWAP over 1–2
 *    `poolOracleRoutes` — the public getter `poolOracleRoutes(uint256)` returns
 *    `(pool, zeroForOne, twapInterval, token0Decimals, token1Decimals)`. A route
 *    with `twapInterval == 0` uses spot `slot0()` (MANIPULABLE); otherwise a
 *    `.observe()` TWAP over that window.
 *  - V3 (`_Pool_V3`): a pluggable `priceAdapter` + `priceRouteHash`; the
 *    underlying pool(s) live in `adapter.priceRoutes(hash)` (opaque bytes).
 */
const POOL_ORACLE_ABI = [
    {
        name: "poolOracleRoutes",
        stateMutability: "view",
        type: "function",
        inputs: [{ type: "uint256" }],
        outputs: [
            { name: "pool", type: "address" },
            { name: "zeroForOne", type: "bool" },
            { name: "twapInterval", type: "uint32" },
            { name: "token0Decimals", type: "uint256" },
            { name: "token1Decimals", type: "uint256" },
        ],
    },
    { name: "priceAdapter", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "address" }] },
    { name: "priceRouteHash", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "bytes32" }] },
];
const num = (v) => {
    try {
        return Number(typeof v === "bigint" ? v : BigInt(v));
    }
    catch {
        return 0;
    }
};
/**
 * Classify Teller's per-pool DEX price oracles. Reads each pool's oracle route
 * config on-chain and evaluates its manipulation resistance (TWAP vs spot).
 * Emits `data/teller-oracles-classified.json`, one entry per `TELLER_<pool>`.
 */
export async function classifyTellerOracles() {
    const poolsByChain = readJsonFile(poolsFile);
    const result = {};
    for (const [chainId, pools] of Object.entries(poolsByChain ?? {})) {
        const rows = (pools ?? []).filter((p) => isAddr(p.pool));
        if (!rows.length)
            continue;
        console.log(`Teller oracles [${chainId}]: ${rows.length} pools`);
        // Read, per pool: route[0], route[1] (V2), priceAdapter, priceRouteHash (V3).
        // allowFailure — V2 pools revert on priceAdapter/hash and on route[1] when
        // single-hop; V3 pools revert on poolOracleRoutes.
        const calls = rows.flatMap((p) => [
            { address: p.pool, name: "poolOracleRoutes", args: [0n] },
            { address: p.pool, name: "poolOracleRoutes", args: [1n] },
            { address: p.pool, name: "priceAdapter", args: [] },
            { address: p.pool, name: "priceRouteHash", args: [] },
        ]);
        const res = (await multicallRetryUniversal({
            chain: chainId,
            calls,
            abi: POOL_ORACLE_ABI,
            allowFailure: true,
            maxRetries: 4,
        }).catch(() => []));
        const route = (r) => {
            if (!r || r === "0x")
                return null;
            const pool = Array.isArray(r) ? toAddr(r[0]) : toAddr(r?.pool);
            if (!isAddr(pool))
                return null;
            const twap = Array.isArray(r) ? num(r[2]) : num(r?.twapInterval);
            const z2o = Array.isArray(r) ? !!r[1] : !!r?.zeroForOne;
            return { pool, zeroForOne: z2o, twapInterval: twap };
        };
        result[chainId] = {};
        rows.forEach((p, i) => {
            const b = i * 4;
            const r0 = route(res[b]);
            const r1 = route(res[b + 1]);
            const adapter = toAddr(res[b + 2]);
            const routeHash = typeof res[b + 3] === "string" && res[b + 3] !== "0x" ? res[b + 3] : null;
            const routes = [r0, r1].filter((x) => !!x);
            const isV2 = routes.length > 0;
            const isV3 = !isV2 && isAddr(adapter);
            const minTwap = routes.length
                ? Math.min(...routes.map((x) => x.twapInterval))
                : null;
            const ps = p.principalSymbol ?? null;
            const cs = p.collateralSymbol ?? null;
            result[chainId][p.pool.toLowerCase()] = {
                market: p.pool,
                principal: p.principal,
                collateral: p.collateral,
                principalSymbol: ps,
                collateralSymbol: cs,
                generation: isV2 ? 2 : isV3 ? 3 : null,
                provider: isV2
                    ? "uniswap-v3-twap"
                    : isV3
                        ? "teller-price-adapter"
                        : "unknown",
                oracle: isV2 ? routes[0].pool : isV3 ? adapter : null,
                routes,
                priceAdapter: isV3 ? adapter : null,
                priceRouteHash: isV3 ? routeHash : null,
                minTwapInterval: minTwap,
                // Teller oracles are token/token (principal per collateral), not /USD.
                denominator: cs,
                intendedPair: ps && cs ? `${ps} / ${cs}` : null,
                // Real TWAP on every route = manipulation-resistant; a spot route (0) or
                // no readable oracle is flagged. V3 adapter TWAP window is inside the
                // adapter (not read here) → left null (evaluate the adapter separately).
                correctOracle: isV2 ? (minTwap ?? 0) > 0 : null,
            };
        });
    }
    return result;
}
