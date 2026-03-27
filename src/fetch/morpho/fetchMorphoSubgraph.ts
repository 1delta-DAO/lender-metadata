import { Chain } from "@1delta/chain-registry";

// ============================================================================
// Goldsky Subgraph Endpoints for Morpho Blue
// ============================================================================

const MORPHO_SUBGRAPH_URLS: Record<string, string> = {
  [Chain.SEI_NETWORK]:
    "https://api.goldsky.com/api/public/project_cmiergfbv4vma01vb642yaeam/subgraphs/morphoblue-sei/1.0.1/gn",
  [Chain.CELO_MAINNET]:
    "https://api.goldsky.com/api/public/project_cmiergfbv4vma01vb642yaeam/subgraphs/morphoblue-celo/1.0.4/gn",
  [Chain.LISK]:
    "https://api.goldsky.com/api/public/project_cmiergfbv4vma01vb642yaeam/subgraphs/morphobluelisk/1.0.1/gn",
  [Chain.SONEIUM]:
    "https://api.goldsky.com/api/public/project_cmiergfbv4vma01vb642yaeam/subgraphs/morphobluesoneium/1.0.2/gn",
  [Chain.TAC_MAINNET]:
    "https://api.goldsky.com/api/public/project_cmiergfbv4vma01vb642yaeam/subgraphs/morphoblue-tac/1.0.0/gn",
};

// ============================================================================
// Subgraph Queries
// ============================================================================

const MARKETS_QUERY = `
{
  markets(first: 100, skip: 0) {
    id
    inputToken {
      id
    }
    borrowedToken {
      id
    }
    rates {
      id
      rate
    }
    oracle {
      id
      oracleAddress
    }
    maximumLTV
    liquidationThreshold
    liquidationPenalty
    inputTokenPriceUSD
    reserveFactor
    totalCollateral
    totalSupplyShares
    totalSupply
    totalBorrow
    totalBorrowShares
    interest
    fee
    irm
    lltv
    lastUpdate
  }
}`;

const META_MORPHOS_QUERY = `
{
  metaMorphos(first: 100, skip: 0) {
    id
    name
    symbol
    decimals
    account {
      positions {
        id
        market {
          id
        }
        side
        balance
        principal
        shares
      }
    }
    asset {
      id
    }
    curator {
      id
    }
    owner {
      id
    }
    guardian {
      id
    }
    allocators {
      account {
        id
      }
    }
    timelock
    fee
    rate {
      id
      rate
    }
    lastTotalAssets
    totalShares
    markets {
      id
      market {
        id
      }
      cap
      currentPendingCap {
        cap
        validAt
        status
      }
    }
  }
}`;

// ============================================================================
// Types
// ============================================================================

interface SubgraphMarket {
  id: string;
  inputToken: { id: string };
  borrowedToken: { id: string };
  rates: { id: string; rate: string }[];
  oracle: { id: string; oracleAddress: string };
  maximumLTV: string;
  liquidationThreshold: string;
  liquidationPenalty: string;
  inputTokenPriceUSD: string;
  reserveFactor: string;
  totalCollateral: string;
  totalSupplyShares: string;
  totalSupply: string;
  totalBorrow: string;
  totalBorrowShares: string;
  interest: string;
  fee: string;
  irm: string;
  lltv: string;
  lastUpdate: string;
}

interface SubgraphMetaMorpho {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  account: {
    positions: {
      id: string;
      market: { id: string };
      side: string;
      balance: string;
      principal: string;
      shares: string;
    }[];
  };
  asset: { id: string };
  curator: { id: string } | null;
  owner: { id: string };
  guardian: { id: string } | null;
  allocators: { account: { id: string } }[];
  timelock: string;
  fee: string;
  rate: { id: string; rate: string } | null;
  lastTotalAssets: string;
  totalShares: string;
  markets: {
    id: string;
    market: { id: string };
    cap: string;
    currentPendingCap: {
      cap: string;
      validAt: string;
      status: string;
    } | null;
  }[];
}

// ============================================================================
// Token List Fetcher
// ============================================================================

type GenericTokenList = Record<
  string,
  { address: string; symbol: string; decimals: number }
>;

const getListUrl = (chainId: string) =>
  `https://raw.githubusercontent.com/1delta-DAO/token-lists/main/${chainId}.json`;

async function getDeltaTokenList(
  chain: string
): Promise<GenericTokenList> {
  try {
    const response = await fetch(getListUrl(chain));
    if (!response.ok) return {};
    const json = (await response.json()) as any;
    return (json.list as GenericTokenList) ?? {};
  } catch {
    return {};
  }
}

// ============================================================================
// Check if a chain has a subgraph endpoint
// ============================================================================

export function hasSubgraph(chainId: string): boolean {
  return chainId in MORPHO_SUBGRAPH_URLS;
}

// ============================================================================
// Fetch and convert subgraph markets to the format expected by MorphoBlueUpdater
// ============================================================================

/**
 * Converts subgraph market data to the unified format expected by the
 * morpho processing pipeline (same shape as Morpho API / on-chain fetch).
 */
export async function fetchMarketsFromSubgraph(
  chainId: string
): Promise<{ markets: { items: any[] } }> {
  const url = MORPHO_SUBGRAPH_URLS[chainId];
  if (!url) {
    throw new Error(`No subgraph URL configured for chain ${chainId}`);
  }

  // Fetch token list for symbol/decimals resolution
  const tokens = await getDeltaTokenList(chainId);

  // Fetch markets from subgraph
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: MARKETS_QUERY, variables: {} }),
  });

  if (!response.ok) {
    throw new Error(
      `Subgraph fetch failed for chain ${chainId}: ${response.status} - ${response.statusText}`
    );
  }

  const json: any = await response.json();
  const markets: SubgraphMarket[] = json.data?.markets ?? [];

  const items: any[] = [];
  for (const market of markets) {
    const collateralAddr = market.inputToken.id.toLowerCase();
    const loanAddr = market.borrowedToken.id.toLowerCase();
    const oracleAddress = market.oracle.oracleAddress;

    // Skip zero-address markets
    if (
      collateralAddr === "0x0000000000000000000000000000000000000000" &&
      loanAddr === "0x0000000000000000000000000000000000000000"
    ) {
      continue;
    }

    // Resolve token metadata from the token list
    const collateralToken = tokens[collateralAddr];
    const loanToken = tokens[loanAddr];

    items.push({
      uniqueKey: market.id,
      lltv: market.lltv, // raw 18-decimal string, numberToBps handles it
      oracleAddress,
      irm: market.irm,
      loanAsset: loanToken ?? {
        address: loanAddr,
        symbol: undefined,
        decimals: undefined,
      },
      collateralAsset: collateralToken ?? {
        address: collateralAddr,
        symbol: undefined,
        decimals: undefined,
      },
    });
  }

  return { markets: { items } };
}

// ============================================================================
// Fetch MetaMorpho vaults from subgraph
// ============================================================================

export async function fetchMetaMorphosFromSubgraph(
  chainId: string
): Promise<SubgraphMetaMorpho[]> {
  const url = MORPHO_SUBGRAPH_URLS[chainId];
  if (!url) {
    throw new Error(`No subgraph URL configured for chain ${chainId}`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: META_MORPHOS_QUERY, variables: {} }),
  });

  if (!response.ok) {
    throw new Error(
      `MetaMorpho subgraph fetch failed for chain ${chainId}: ${response.status} - ${response.statusText}`
    );
  }

  const json: any = await response.json();
  return json.data?.metaMorphos ?? [];
}
