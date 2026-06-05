// Per-chain Dolomite aggregator-trader (`IExchangeWrapper`) addresses for the
// calldata-sdk `DolomiteTrader` swaps/loops. These live in dolomite's separate
// `dolomite-margin-modules` deployments (NOT the core `deployed.json`), so we
// fetch the published deployments file and extract them, preferring the latest
// contract version per aggregator.

const DEPLOYMENTS_URL =
  "https://raw.githubusercontent.com/dolomite-exchange/dolomite-margin-modules/master/packages/deployment/src/deploy/deployments.json";

// DolomiteAggregator name → candidate contract keys, newest version first.
const AGGREGATOR_CONTRACTS: Record<string, string[]> = {
  odos: ["OdosAggregatorTraderV2", "OdosAggregatorTraderV1"],
  paraswap: ["ParaswapAggregatorTraderV2", "ParaswapAggregatorTrader"],
  oogabooga: ["OogaBoogaAggregatorTraderV2", "OogaBoogaAggregatorTraderV1"],
  enso: ["EnsoAggregatorTraderV1"],
};

export type DolomiteAggregatorTraders = {
  [chainId: string]: { [aggregator: string]: string };
};

/**
 * Fetch the deployments file and build `{ [chainId]: { [aggregator]: address } }`.
 * Returns `{}` on failure (swaps/loops simply stay unavailable; base lending +
 * position ops are unaffected).
 */
export async function fetchDolomiteAggregatorTraders(
  chainIds: string[],
): Promise<DolomiteAggregatorTraders> {
  let deployments: any;
  try {
    const res = await fetch(DEPLOYMENTS_URL);
    if (!res.ok) return {};
    deployments = await res.json();
  } catch {
    return {};
  }

  const out: DolomiteAggregatorTraders = {};
  for (const chainId of chainIds) {
    const entry: { [aggregator: string]: string } = {};
    for (const [aggregator, candidates] of Object.entries(
      AGGREGATOR_CONTRACTS,
    )) {
      for (const contract of candidates) {
        const addr = deployments?.[contract]?.[chainId]?.address;
        if (addr) {
          entry[aggregator] = addr;
          break; // newest version wins
        }
      }
    }
    if (Object.keys(entry).length > 0) out[chainId] = entry;
  }
  return out;
}
