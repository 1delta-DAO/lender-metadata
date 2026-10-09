import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { toAddr } from "../oracle-classifier/normalize.js";
// config/teller.json: chain -> { tellerV2, marketRegistry, ... }
const configFile = "./config/teller.json";
// data/teller-pools.json: chain -> [{ pool, principal, collateral, ... }]
const poolsFile = "./data/teller-pools.json";
const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;
/**
 * Minimal ABI for reading a LenderCommitmentGroup pool's AUTHORITATIVE token
 * config + immutable params. The Teller UI middleware API (`/tvl/borrow-multi`)
 * has been observed to return WRONG token addresses/decimals for some pools
 * (e.g. reporting a "BITCOIN" 8-dec token for a pool that actually lends an
 * 18-dec "EDGE" token), so token metadata MUST be read from the pool on-chain,
 * never trusted from the API.
 */
const POOL_ABI = [
    { name: "getPrincipalTokenAddress", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "address" }] },
    { name: "getCollateralTokenAddress", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "address" }] },
    { name: "getMarketId", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "getMaxLoanDuration", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "uint32" }] },
    { name: "totalAssets", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "uint256" }] },
];
const ERC20_ABI = [
    { name: "decimals", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "uint8" }] },
    { name: "symbol", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "string" }] },
];
const num = (v) => {
    try {
        if (v == null)
            return undefined;
        return Number(typeof v === "bigint" ? v : BigInt(v));
    }
    catch {
        return undefined;
    }
};
/**
 * Rebuild data/teller-pools.json with token metadata read from each pool
 * ON-CHAIN (principal/collateral addresses, decimals, symbols) instead of the
 * unreliable middleware API. Pool ADDRESSES + the `isV2`/`name` hints are kept
 * from the existing file (which discovered them from the API); everything else
 * is overwritten with on-chain truth. `marketId` + `maxLoanDuration` are baked
 * from on-chain so the runtime need not re-read them.
 */
export async function fetchTellerPoolsOnChain() {
    const config = readJsonFile(configFile);
    const existing = (readJsonFile(poolsFile) ?? {});
    const out = {};
    for (const [chainId, rows] of Object.entries(existing)) {
        const pools = (rows ?? []).filter((r) => isAddr(r.pool));
        if (!pools.length || !config?.[chainId]?.tellerV2) {
            out[chainId] = rows ?? [];
            continue;
        }
        console.log(`Teller pools [${chainId}]: ${pools.length} pools`);
        // 1. per-pool on-chain config (4 reads/pool).
        const calls = pools.flatMap((p) => [
            { address: p.pool, name: "getPrincipalTokenAddress", args: [] },
            { address: p.pool, name: "getCollateralTokenAddress", args: [] },
            { address: p.pool, name: "getMarketId", args: [] },
            { address: p.pool, name: "getMaxLoanDuration", args: [] },
        ]);
        // A whole-chain multicall failure means "no update", never "empty chain":
        // this file is the pool ROSTER (discovery never re-adds — addresses come
        // from the existing file), so dropping rows here is a permanent, monotonic
        // loss. On 2026-09-09 one bad RPC night deleted 64 of 106 chain-1 pools
        // (commit e7af954) and froze their prod rows for 23 days.
        let res;
        try {
            res = (await multicallRetryUniversal({
                chain: chainId,
                calls,
                abi: POOL_ABI,
                allowFailure: true,
                maxRetries: 4,
            }));
        }
        catch (err) {
            console.error(`Teller pools [${chainId}]: multicall failed — keeping the existing ${pools.length} rows unchanged:`, err?.message ?? err);
            out[chainId] = rows ?? [];
            continue;
        }
        const resolved = pools.map((p, i) => {
            const b = i * 4;
            return {
                p,
                principal: toAddr(res[b]),
                collateral: toAddr(res[b + 1]),
                marketId: num(res[b + 2]),
                maxLoanDuration: num(res[b + 3]),
            };
        });
        // 2. decimals + symbol for every unique token.
        const tokens = [
            ...new Set(resolved.flatMap((r) => [r.principal, r.collateral]).filter(isAddr)),
        ];
        const decRes = (await multicallRetryUniversal({
            chain: chainId,
            calls: tokens.map((t) => ({ address: t, name: "decimals", args: [] })),
            abi: ERC20_ABI,
            allowFailure: true,
            maxRetries: 6,
        }).catch(() => []));
        const symRes = (await multicallRetryUniversal({
            chain: chainId,
            calls: tokens.map((t) => ({ address: t, name: "symbol", args: [] })),
            abi: ERC20_ABI,
            allowFailure: true,
            maxRetries: 6,
        }).catch(() => []));
        const decByToken = new Map();
        const symByToken = new Map();
        tokens.forEach((t, i) => {
            decByToken.set(t, num(decRes[i]));
            symByToken.set(t, typeof symRes[i] === "string" ? symRes[i] : undefined);
        });
        // A pool whose reads failed THIS run keeps its existing row verbatim —
        // "unreadable tonight" is an RPC statement, not a market statement. Only
        // a pool that was never readable (no principal/collateral on file either)
        // is dropped, and that is counted out loud.
        let dropped = 0;
        out[chainId] = resolved
            .map((r) => {
            if (!isAddr(r.principal) || !isAddr(r.collateral)) {
                if (isAddr(r.p.principal) && isAddr(r.p.collateral))
                    return r.p;
                dropped += 1;
                return undefined;
            }
            const pd = decByToken.get(r.principal);
            const cd = decByToken.get(r.collateral);
            const ps = symByToken.get(r.principal) ?? r.p.principalSymbol;
            const cs = symByToken.get(r.collateral) ?? r.p.collateralSymbol;
            const row = {
                pool: r.p.pool,
                principal: r.principal,
                principalSymbol: ps ?? "?",
                principalDecimals: pd ?? r.p.principalDecimals ?? 18,
                collateral: r.collateral,
                collateralSymbol: cs ?? "?",
                collateralDecimals: cd ?? r.p.collateralDecimals ?? 18,
                name: ps && cs ? `Teller ${ps} / ${cs}` : r.p.name,
            };
            if (r.marketId != null)
                row.marketId = String(r.marketId);
            if (r.maxLoanDuration != null)
                row.maxLoanDuration = r.maxLoanDuration;
            if (r.p.isV2 != null)
                row.isV2 = r.p.isV2;
            return row;
        })
            .filter((row) => row !== undefined);
        const kept = resolved.filter((r) => (!isAddr(r.principal) || !isAddr(r.collateral)) &&
            isAddr(r.p.principal) &&
            isAddr(r.p.collateral)).length;
        if (kept > 0)
            console.log(`  ${kept} pool(s) unreadable this run — existing rows kept`);
        if (dropped > 0)
            console.log(`  ${dropped} pool(s) dropped (never had readable tokens)`);
    }
    return out;
}
