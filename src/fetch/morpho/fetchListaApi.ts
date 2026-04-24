// ============================================================================
// Lista DAO (moolah) markets API fetcher.
// The API is access-restricted, so this runs as a separate job from updateAll.
// ============================================================================

import { parseAbi } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import {
  decodeListaMarkets,
  MORPHO_LENS,
  normalizeToBytes,
} from "@1delta/margin-fetcher";

const BASE_URL = "https://api.lista.org/api/moolah/borrow/markets";

// Lista API returns a "chain" string per market — map it to the chain id used
// throughout this repo. Entries not in this map are ignored.
const CHAIN_NAME_TO_ID: Record<string, string> = {
  bsc: "56",
  ethereum: "1",
};

type ListaMarket = {
  id: string;
  chain: string;
};

type ListaResponse = {
  code: string;
  msg: string;
  data: {
    total: number;
    list: ListaMarket[];
  };
};

export type ListaMarketsByChain = Record<string, string[]>;

export async function fetchListaMarkets(
  pageSize = 100,
): Promise<ListaMarketsByChain> {
  const chainsParam = Object.keys(CHAIN_NAME_TO_ID).join(",");
  const byChain: ListaMarketsByChain = {};
  const seen: Record<string, Set<string>> = {};

  let page = 1;
  let total = Infinity;
  let fetched = 0;

  while (fetched < total) {
    const url =
      `${BASE_URL}?page=${page}&pageSize=${pageSize}` +
      `&sort=liquidity&order=desc&keyword=&zone=0,3&chain=${chainsParam}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Lista API error: ${res.status} ${res.statusText} (page ${page})`,
      );
    }
    const body = (await res.json()) as ListaResponse;
    if (body.code !== "000000000") {
      throw new Error(`Lista API non-success code: ${body.code} ${body.msg}`);
    }

    total = body.data.total;
    const items = body.data.list ?? [];
    fetched += items.length;

    for (const m of items) {
      const chainId = CHAIN_NAME_TO_ID[m.chain];
      if (!chainId || !m.id) continue;
      if (!seen[chainId]) {
        seen[chainId] = new Set();
        byChain[chainId] = [];
      }
      if (!seen[chainId].has(m.id)) {
        seen[chainId].add(m.id);
        byChain[chainId].push(m.id);
      }
    }

    if (items.length === 0) break;
    page++;
  }

  for (const chainId of Object.keys(byChain)) {
    byChain[chainId].sort();
  }

  return byChain;
}

export type ListaMarketAssets = {
  marketId: string;
  loanToken: string;
  collateralToken: string;
};

/**
 * Resolve the raw loan/collateral token addresses for a set of Lista market ids
 * via the on-chain lens. Used to cross-reference assets against the token list.
 */
export async function resolveListaMarketAssets(
  chainId: string,
  poolAddress: string,
  marketIds: string[],
): Promise<ListaMarketAssets[]> {
  if (marketIds.length === 0) return [];
  const lensAddress = MORPHO_LENS[chainId];
  if (!lensAddress) {
    throw new Error(`No MORPHO_LENS address for chain ${chainId}`);
  }

  const abi = parseAbi([
    "function getListaMarketDataCompact(address morpho, bytes32[] calldata marketsIds) external view returns (bytes memory data)",
  ]);

  const results = await multicallRetryUniversal({
    chain: chainId,
    calls: [
      {
        address: lensAddress,
        name: "getListaMarketDataCompact",
        args: [poolAddress, marketIds],
      },
    ],
    abi,
    allowFailure: false,
  });

  const decoded = decodeListaMarkets(
    normalizeToBytes(results[0] as unknown as string),
  );

  return decoded.map((m: any, i: number) => ({
    marketId: marketIds[i],
    loanToken: (m.loanToken ?? "").toLowerCase(),
    collateralToken: (m.collateralToken ?? "").toLowerCase(),
  }));
}
