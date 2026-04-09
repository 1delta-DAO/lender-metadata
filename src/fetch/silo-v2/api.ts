// Discover Silo v2 pairs via the public Silo frontend API.
//
// Endpoint: POST https://v2.silo.finance/api/borrow
//
// The response groups pools by `marketId` (== siloConfig). Each pool has a
// `borrowSilo` and `supplySilo` half describing one borrow direction; both
// halves of the pair appear under the same `marketId`. We dedupe by
// (chainId, marketId) and stash both silo addresses + their tokens / decimals
// / symbols so the on-chain stage doesn't need ERC-20 metadata calls.

const API_URL = "https://v2.silo.finance/api/borrow";

// `chainKey` strings the Silo API uses → numeric chainIds matching
// `@1delta/chain-registry`.
const CHAIN_KEY_TO_ID: Record<string, string> = {
  ethereum: "1",
  sonic: "146",
  arbitrum: "42161",
  avalanche: "43114",
};

type ApiSiloHalf = {
  _tag: "borrow" | "supply";
  siloIndex: string; // "0" | "1"
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  tokenAddress: string;
  siloId: string; // e.g. "sonic-0xabc..."
};

type ApiPool = {
  chainKey: string;
  poolId: string; // chainKey-<address>
  marketId: string; // chainKey-<siloConfig>
  siloSymbol0: string;
  siloSymbol1: string;
  borrowSilo: ApiSiloHalf;
  supplySilo: ApiSiloHalf;
};

type ApiResponse = {
  totalPools: number;
  pools: ApiPool[];
};

export type ApiHalf = {
  silo: string;
  token: string;
  decimals: number;
  symbol: string;
};

export type ApiMarket = {
  chainId: string;
  siloConfig: string;
  name: string;
  silo0: ApiHalf;
  silo1: ApiHalf;
};

function stripChainPrefix(id: string): string {
  const idx = id.indexOf("-");
  return idx >= 0 ? id.slice(idx + 1) : id;
}

function toHalf(side: ApiSiloHalf): ApiHalf {
  return {
    silo: stripChainPrefix(side.siloId).toLowerCase(),
    token: side.tokenAddress.toLowerCase(),
    decimals: side.tokenDecimals,
    symbol: side.tokenSymbol,
  };
}

async function fetchPoolsPage(
  offset: number,
  limit: number,
): Promise<ApiResponse> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      borrowSearch: null,
      supplySearch: null,
      chainKeys: [],
      sort: null,
      minLiquidityUsd: "0",
      limit,
      offset,
      supplyTokenAddress: null,
      borrowTokenAddress: null,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `silo.finance api error: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as ApiResponse;
}

/**
 * Fetch every Silo v2 market from the public API and dedupe by `marketId`.
 *
 * We page in 100s; at the time of writing the global total is < 100 so this
 * usually completes in one request, but the loop is safe for future growth.
 */
export async function fetchSiloV2MarketsFromApi(): Promise<ApiMarket[]> {
  const PAGE = 100;
  const seen = new Map<string, ApiMarket>();

  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const page = await fetchPoolsPage(offset, PAGE);
    total = page.totalPools ?? page.pools.length;
    for (const pool of page.pools ?? []) {
      const chainId = CHAIN_KEY_TO_ID[pool.chainKey];
      if (!chainId) continue;

      const dedupeKey = `${chainId}:${pool.marketId.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;

      // Use siloIndex on each half to map to silo0 / silo1.
      const sides = [pool.borrowSilo, pool.supplySilo];
      const byIndex: { [k: string]: ApiHalf } = {};
      for (const s of sides) byIndex[s.siloIndex] = toHalf(s);
      const half0 = byIndex["0"];
      const half1 = byIndex["1"];
      if (!half0 || !half1) continue;

      seen.set(dedupeKey, {
        chainId,
        siloConfig: stripChainPrefix(pool.marketId).toLowerCase(),
        name: `${pool.siloSymbol0}/${pool.siloSymbol1}`,
        silo0: half0,
        silo1: half1,
      });
    }
    if (page.pools.length < PAGE) break;
    offset += PAGE;
  }

  return [...seen.values()];
}
