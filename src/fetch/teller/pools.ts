import { multicallRetryUniversal } from "@1delta/providers";
import { readJsonFile } from "../utils/index.js";
import { toAddr } from "../oracle-classifier/normalize.js";

// config/teller.json: chain -> { tellerV2, marketRegistry, ... }
const configFile = "./config/teller.json";
// data/teller-pools.json: chain -> [{ pool, principal, collateral, ... }]
const poolsFile = "./data/teller-pools.json";

const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a: any): a is string =>
  typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO;

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
] as const;

const ERC20_ABI = [
  { name: "decimals", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", stateMutability: "view", type: "function", inputs: [], outputs: [{ type: "string" }] },
] as const;

export type TellerPoolRow = {
  pool: string;
  marketId?: string;
  principal: string;
  principalSymbol: string;
  principalDecimals: number;
  collateral: string;
  collateralSymbol: string;
  collateralDecimals: number;
  maxLoanDuration?: number;
  isV2?: boolean;
  name?: string;
};

export type TellerPoolsByChain = { [chainId: string]: TellerPoolRow[] };

const num = (v: any): number | undefined => {
  try {
    if (v == null) return undefined;
    return Number(typeof v === "bigint" ? v : BigInt(v));
  } catch {
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
export async function fetchTellerPoolsOnChain(): Promise<TellerPoolsByChain> {
  const config = readJsonFile(configFile) as Record<string, { tellerV2?: string }>;
  const existing = (readJsonFile(poolsFile) ?? {}) as TellerPoolsByChain;
  const out: TellerPoolsByChain = {};

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
    const res = (await multicallRetryUniversal({
      chain: chainId,
      calls,
      abi: POOL_ABI as any,
      allowFailure: true,
      maxRetries: 4,
    }).catch(() => [])) as any[];

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
      ...new Set(
        resolved.flatMap((r) => [r.principal, r.collateral]).filter(isAddr),
      ),
    ] as string[];
    const decRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: tokens.map((t) => ({ address: t, name: "decimals", args: [] })),
      abi: ERC20_ABI as any,
      allowFailure: true,
      maxRetries: 6,
    }).catch(() => [])) as any[];
    const symRes = (await multicallRetryUniversal({
      chain: chainId,
      calls: tokens.map((t) => ({ address: t, name: "symbol", args: [] })),
      abi: ERC20_ABI as any,
      allowFailure: true,
      maxRetries: 6,
    }).catch(() => [])) as any[];
    const decByToken = new Map<string, number | undefined>();
    const symByToken = new Map<string, string | undefined>();
    tokens.forEach((t, i) => {
      decByToken.set(t, num(decRes[i]));
      symByToken.set(t, typeof symRes[i] === "string" ? symRes[i] : undefined);
    });

    out[chainId] = resolved
      .filter((r) => isAddr(r.principal) && isAddr(r.collateral))
      .map((r) => {
        const pd = decByToken.get(r.principal!);
        const cd = decByToken.get(r.collateral!);
        const ps = symByToken.get(r.principal!) ?? r.p.principalSymbol;
        const cs = symByToken.get(r.collateral!) ?? r.p.collateralSymbol;
        const row: TellerPoolRow = {
          pool: r.p.pool,
          principal: r.principal!,
          principalSymbol: ps ?? "?",
          principalDecimals: pd ?? r.p.principalDecimals ?? 18,
          collateral: r.collateral!,
          collateralSymbol: cs ?? "?",
          collateralDecimals: cd ?? r.p.collateralDecimals ?? 18,
          name: ps && cs ? `Teller ${ps} / ${cs}` : r.p.name,
        };
        if (r.marketId != null) row.marketId = String(r.marketId);
        if (r.maxLoanDuration != null) row.maxLoanDuration = r.maxLoanDuration;
        if (r.p.isV2 != null) row.isV2 = r.p.isV2;
        return row;
      });
    const dropped = resolved.length - out[chainId].length;
    if (dropped > 0) console.log(`  ${dropped} pool(s) dropped (unreadable tokens)`);
  }

  return out;
}
