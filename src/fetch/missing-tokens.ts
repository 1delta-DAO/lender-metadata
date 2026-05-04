// ============================================================================
// Collects every underlying/collateral/loan token address referenced by the
// lender data files, groups them by chain, and returns the subset that is
// missing from the 1delta-DAO token lists. The output is shaped for batch
// token-detail fetches done elsewhere:
//
//   { [chainId]: ["0xabc...", "0xdef...", ...] }
//
// Only addresses are returned — name/symbol/decimals discovery is the caller's
// responsibility.
// ============================================================================

import { zeroAddress } from "viem";
import { readJsonFile } from "./utils/index.js";

const TOKEN_LIST_URL = (chainId: string) =>
  `https://raw.githubusercontent.com/1delta-DAO/token-lists/main/${chainId}.json`;

const SOURCES = {
  aaveReserves: "./data/aave-reserves.json",
  aaveTokens: "./data/aave-tokens.json",
  aaveV4Spokes: "./data/aave-v4-spokes.json",
  compoundV2Tokens: "./data/compound-v2-tokens.json",
  compoundV3BaseData: "./data/compound-v3-base-data.json",
  compoundV3Reserves: "./data/compound-v3-reserves.json",
  eulerVaults: "./data/euler-vaults.json",
  fluidVaults: "./data/fluid-vaults.json",
  initConfig: "./data/init-config.json",
  morphoOraclesData: "./data/morpho-oracles-data.json",
  morphoTypeVaults: "./data/morpho-type-vaults.json",
  siloV2: "./data/silo-v2-markets.json",
  siloV3: "./data/silo-v3-markets.json",
} as const;

export type TokensByChain = Record<string, string[]>;

function tryRead(path: string): any | null {
  try {
    return readJsonFile(path);
  } catch {
    return null;
  }
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function add(map: Map<string, Set<string>>, chainId: string, token: unknown) {
  if (!isAddress(token)) return;
  const lower = token.toLowerCase();
  if (lower === zeroAddress) return;
  let set = map.get(chainId);
  if (!set) {
    set = new Set();
    map.set(chainId, set);
  }
  set.add(lower);
}

/** Collect every underlying/collateral/loan token address referenced by the
 *  lender data files, grouped by chain id (lowercased addresses). */
export function collectLendingTokens(): TokensByChain {
  const tokens = new Map<string, Set<string>>();

  // aave-reserves.json: { FORK: { chainId: [token, ...] } }
  const aaveReserves = tryRead(SOURCES.aaveReserves);
  if (aaveReserves) {
    for (const byChain of Object.values<any>(aaveReserves)) {
      for (const [chainId, list] of Object.entries<any>(byChain ?? {})) {
        if (Array.isArray(list)) for (const t of list) add(tokens, chainId, t);
      }
    }
  }

  // aave-tokens.json: { FORK: { chainId: { underlying: {...} } } } — keys are tokens
  const aaveTokens = tryRead(SOURCES.aaveTokens);
  if (aaveTokens) {
    for (const byChain of Object.values<any>(aaveTokens)) {
      for (const [chainId, byUnderlying] of Object.entries<any>(byChain ?? {})) {
        for (const t of Object.keys(byUnderlying ?? {})) add(tokens, chainId, t);
      }
    }
  }

  // aave-v4-spokes.json: { chainId: { spoke: { reserves: [{ underlying }] } } }
  const aaveV4Spokes = tryRead(SOURCES.aaveV4Spokes);
  if (aaveV4Spokes) {
    for (const [chainId, bySpoke] of Object.entries<any>(aaveV4Spokes)) {
      for (const spoke of Object.values<any>(bySpoke ?? {})) {
        for (const r of spoke?.reserves ?? []) add(tokens, chainId, r?.underlying);
      }
    }
  }

  // compound-v2-tokens.json: { FORK: { chainId: [{ cToken, underlying }] } }
  const compV2 = tryRead(SOURCES.compoundV2Tokens);
  if (compV2) {
    for (const byChain of Object.values<any>(compV2)) {
      for (const [chainId, list] of Object.entries<any>(byChain ?? {})) {
        for (const e of list ?? []) add(tokens, chainId, e?.underlying);
      }
    }
  }

  // compound-v3-base-data.json: { FORK: { chainId: { baseAsset } } }
  const compV3Base = tryRead(SOURCES.compoundV3BaseData);
  if (compV3Base) {
    for (const byChain of Object.values<any>(compV3Base)) {
      for (const [chainId, entry] of Object.entries<any>(byChain ?? {})) {
        add(tokens, chainId, entry?.baseAsset);
      }
    }
  }

  // compound-v3-reserves.json: { FORK: { chainId: [token, ...] } }
  const compV3Res = tryRead(SOURCES.compoundV3Reserves);
  if (compV3Res) {
    for (const byChain of Object.values<any>(compV3Res)) {
      for (const [chainId, list] of Object.entries<any>(byChain ?? {})) {
        if (Array.isArray(list)) for (const t of list) add(tokens, chainId, t);
      }
    }
  }

  // euler-vaults.json: { FORK: { chainId: [{ underlying, vault }] } }
  const euler = tryRead(SOURCES.eulerVaults);
  if (euler) {
    for (const byChain of Object.values<any>(euler)) {
      for (const [chainId, list] of Object.entries<any>(byChain ?? {})) {
        for (const e of list ?? []) add(tokens, chainId, e?.underlying);
      }
    }
  }

  // fluid-vaults.json: { chainId: { vault: { borrow|supply: { assets: [{underlying}] } } } }
  const fluid = tryRead(SOURCES.fluidVaults);
  if (fluid) {
    for (const [chainId, byVault] of Object.entries<any>(fluid)) {
      for (const v of Object.values<any>(byVault ?? {})) {
        for (const side of ["borrow", "supply"] as const) {
          for (const a of v?.[side]?.assets ?? []) add(tokens, chainId, a?.underlying);
        }
      }
    }
  }

  // init-config.json: { FORK: { chainId: [{ pool, underlying }] } }
  const init = tryRead(SOURCES.initConfig);
  if (init) {
    for (const byChain of Object.values<any>(init)) {
      for (const [chainId, list] of Object.entries<any>(byChain ?? {})) {
        for (const e of list ?? []) add(tokens, chainId, e?.underlying);
      }
    }
  }

  // morpho-oracles-data.json: { chainId: { marketId: { collateralAsset, loanAsset } } }
  const morphoOracles = tryRead(SOURCES.morphoOraclesData);
  if (morphoOracles) {
    for (const [chainId, byMarket] of Object.entries<any>(morphoOracles)) {
      for (const m of Object.values<any>(byMarket ?? {})) {
        add(tokens, chainId, m?.collateralAsset);
        add(tokens, chainId, m?.loanAsset);
      }
    }
  }

  // morpho-type-vaults.json: { FORK: { chainId: [{ vault, underlying }] } }
  const morphoVaults = tryRead(SOURCES.morphoTypeVaults);
  if (morphoVaults) {
    for (const byChain of Object.values<any>(morphoVaults)) {
      for (const [chainId, list] of Object.entries<any>(byChain ?? {})) {
        for (const e of list ?? []) add(tokens, chainId, e?.underlying);
      }
    }
  }

  // silo-v2-markets.json / silo-v3-markets.json: { chainId: [{ silo0: {token}, silo1: {token} }] }
  for (const path of [SOURCES.siloV2, SOURCES.siloV3]) {
    const silo = tryRead(path);
    if (!silo) continue;
    for (const [chainId, list] of Object.entries<any>(silo)) {
      for (const m of list ?? []) {
        add(tokens, chainId, m?.silo0?.token);
        add(tokens, chainId, m?.silo1?.token);
      }
    }
  }

  return Object.fromEntries(
    Array.from(tokens.entries())
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([chainId, set]) => [chainId, Array.from(set).sort()]),
  );
}

async function loadTokenList(chainId: string): Promise<Set<string> | null> {
  const res = await fetch(TOKEN_LIST_URL(chainId));
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `Token list fetch failed for chain ${chainId}: ${res.status}`,
    );
  }
  const body = (await res.json()) as { list: Record<string, unknown> };
  return new Set(Object.keys(body.list).map((a) => a.toLowerCase()));
}

export type CollectMissingOptions = {
  /** If true, chains with no token-list entry on GitHub (404) are reported as
   *  having every token missing. Defaults to true. */
  includeChainsWithoutList?: boolean;
};

/** Collect every lending token address and return the subset missing from the
 *  1delta-DAO token lists, grouped by chain id. */
export async function collectMissingLendingTokens(
  opts: CollectMissingOptions = {},
): Promise<TokensByChain> {
  const { includeChainsWithoutList = true } = opts;
  const all = collectLendingTokens();
  const chainIds = Object.keys(all);

  const lists = await Promise.all(
    chainIds.map(async (chainId) => {
      try {
        return [chainId, await loadTokenList(chainId)] as const;
      } catch (err) {
        console.warn(`Token list fetch failed for chain ${chainId}:`, err);
        return [chainId, undefined] as const;
      }
    }),
  );

  const missing: TokensByChain = {};
  for (const [chainId, list] of lists) {
    const tokens = all[chainId];
    if (list === undefined) continue; // fetch error — skip rather than mislabel
    if (list === null) {
      if (includeChainsWithoutList) missing[chainId] = tokens;
      continue;
    }
    const gap = tokens.filter((t) => !list.has(t));
    if (gap.length > 0) missing[chainId] = gap;
  }
  return missing;
}
