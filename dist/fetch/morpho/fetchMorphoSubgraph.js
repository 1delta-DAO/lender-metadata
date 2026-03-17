import { Chain } from "@1delta/chain-registry";
// ============================================================================
// Goldsky Subgraph Endpoints for Morpho Blue
// ============================================================================
const MORPHO_SUBGRAPH_URLS = {
    [Chain.SEI_NETWORK]: "https://api.goldsky.com/api/public/project_cmiergfbv4vma01vb642yaeam/subgraphs/morphoblue-sei/1.0.1/gn",
    [Chain.CELO_MAINNET]: "https://api.goldsky.com/api/public/project_cmiergfbv4vma01vb642yaeam/subgraphs/morphoblue-celo/1.0.4/gn",
    [Chain.LISK]: "https://api.goldsky.com/api/public/project_cmiergfbv4vma01vb642yaeam/subgraphs/morphobluelisk/1.0.1/gn",
    [Chain.SONEIUM]: "https://api.goldsky.com/api/public/project_cmiergfbv4vma01vb642yaeam/subgraphs/morphobluesoneium/1.0.2/gn",
    [Chain.TAC_MAINNET]: "https://api.goldsky.com/api/public/project_cmiergfbv4vma01vb642yaeam/subgraphs/morphoblue-tac/1.0.0/gn",
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
const getListUrl = (chainId) => `https://raw.githubusercontent.com/1delta-DAO/token-lists/main/${chainId}.json`;
async function getDeltaTokenList(chain) {
    try {
        const response = await fetch(getListUrl(chain));
        if (!response.ok)
            return {};
        const json = (await response.json());
        return json.list ?? {};
    }
    catch {
        return {};
    }
}
// ============================================================================
// Check if a chain has a subgraph endpoint
// ============================================================================
export function hasSubgraph(chainId) {
    return chainId in MORPHO_SUBGRAPH_URLS;
}
// ============================================================================
// Fetch and convert subgraph markets to the format expected by MorphoBlueUpdater
// ============================================================================
/**
 * Converts subgraph market data to the unified format expected by the
 * morpho processing pipeline (same shape as Morpho API / on-chain fetch).
 */
export async function fetchMarketsFromSubgraph(chainId) {
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
        throw new Error(`Subgraph fetch failed for chain ${chainId}: ${response.status} - ${response.statusText}`);
    }
    const json = await response.json();
    const markets = json.data?.markets ?? [];
    const items = [];
    for (const market of markets) {
        const collateralAddr = market.inputToken.id.toLowerCase();
        const loanAddr = market.borrowedToken.id.toLowerCase();
        const oracleAddress = market.oracle.oracleAddress;
        // Skip zero-address markets
        if (collateralAddr === "0x0000000000000000000000000000000000000000" &&
            loanAddr === "0x0000000000000000000000000000000000000000") {
            continue;
        }
        // Resolve token metadata from the token list
        const collateralToken = tokens[collateralAddr];
        const loanToken = tokens[loanAddr];
        items.push({
            uniqueKey: market.id,
            lltv: market.lltv, // raw 18-decimal string, numberToBps handles it
            oracleAddress,
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
export async function fetchMetaMorphosFromSubgraph(chainId) {
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
        throw new Error(`MetaMorpho subgraph fetch failed for chain ${chainId}: ${response.status} - ${response.statusText}`);
    }
    const json = await response.json();
    return json.data?.metaMorphos ?? [];
}
