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

/** The deployments file, or `undefined` when it cannot be read. */
export async function fetchDolomiteModuleDeployments(): Promise<any> {
  try {
    const res = await fetch(DEPLOYMENTS_URL);
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * The three modern routers (`DepositWithdrawalRouter`, `BorrowPositionRouter`,
 * `GenericTraderRouter`) are upgradeable proxies at one CREATE2 address per
 * chain. data-sdk carries the same three as `DOLOMITE_ROUTER_DEFAULTS` and uses
 * them only when a chain's row lacks the field, so publishing them here is what
 * lets a redeploy land without an SDK release.
 */
const ROUTER_CONTRACTS = {
  depositWithdrawalRouter: "DepositWithdrawalRouterProxy",
  borrowPositionRouter: "BorrowPositionRouterProxy",
  genericTraderRouter: "GenericTraderRouterProxy",
} as const;

export type DolomiteRouters = {
  [chainId: string]: Partial<Record<keyof typeof ROUTER_CONTRACTS, string>>;
};

/** `{ [chainId]: { depositWithdrawalRouter, borrowPositionRouter, genericTraderRouter } }`. */
export function extractDolomiteRouters(
  chainIds: string[],
  deployments: any,
): DolomiteRouters {
  const out: DolomiteRouters = {};
  if (!deployments) return out;
  for (const chainId of chainIds) {
    const entry: DolomiteRouters[string] = {};
    for (const [field, contract] of Object.entries(ROUTER_CONTRACTS)) {
      const addr = deployments?.[contract]?.[chainId]?.address;
      if (addr) entry[field as keyof typeof ROUTER_CONTRACTS] = addr;
    }
    if (Object.keys(entry).length > 0) out[chainId] = entry;
  }
  return out;
}

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
  deployments?: any,
): Promise<DolomiteAggregatorTraders> {
  deployments ??= await fetchDolomiteModuleDeployments();
  if (!deployments) return {};

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
