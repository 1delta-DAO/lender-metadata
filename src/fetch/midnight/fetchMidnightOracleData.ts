import { readJsonFile } from "../utils/index.js";
import {
  fetchMorphoOracleData,
  type ResolvedOracleMarket,
  type MorphoOraclesDataMap,
} from "../morpho/fetchMorphoOracleData.js";

const midnightMarketsFile = "./data/midnight-markets.json";
const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a);

type MidnightMarket = {
  marketId: string;
  loanToken: string;
  loanDecimals?: number;
  collateralParams?: Array<{ token: string; oracle?: string; decimals?: number }>;
};

/**
 * Classify Morpho Midnight oracles.
 *
 * Midnight is Morpho-lineage — its per-collateral oracles are the same
 * MorphoChainlinkOracleV2 contracts pricing collateral in loan-token terms — so it
 * reuses the Morpho oracle classifier *verbatim* by supplying pre-resolved markets
 * (with a synthetic `meta`) from data/midnight-markets.json. `onlyInjected` skips the
 * Morpho subgraph entirely, so only Midnight's markets are classified. Output shape
 * == morpho-oracles-data.json, keyed by marketId, fork `MORPHO_MIDNIGHT` (which the
 * risk-data `normalizeMorpho` already keys as `MORPHO_MIDNIGHT_<marketId>`).
 *
 * NOTE: keyed by marketId (the Morpho schema), so a market with multiple collateral
 * legs would keep only the last leg's oracle. All current Midnight markets are
 * single-collateral, so this is exact today; revisit if multi-leg markets appear.
 */
export async function fetchMidnightOracleData(): Promise<MorphoOraclesDataMap> {
  const raw = readJsonFile(midnightMarketsFile) as Record<string, MidnightMarket[]>;
  const injectedByChain: Record<string, ResolvedOracleMarket[]> = {};

  for (const [chainId, markets] of Object.entries(raw ?? {})) {
    if (chainId.startsWith("_") || !Array.isArray(markets)) continue;
    const rows: ResolvedOracleMarket[] = [];
    for (const m of markets) {
      if (!m?.marketId || !isAddr(m.loanToken)) continue;
      for (const cp of m.collateralParams ?? []) {
        if (!isAddr(cp?.oracle) || !isAddr(cp?.token)) continue;
        const oracle = cp.oracle.toLowerCase();
        const loanAsset = m.loanToken.toLowerCase();
        const collateralAsset = cp.token.toLowerCase();
        rows.push({
          oracle,
          loanAsset,
          collateralAsset,
          loanAssetDecimals: m.loanDecimals,
          collateralAssetDecimals: cp.decimals,
          meta: {
            fork: "MORPHO_MIDNIGHT",
            uniqueKey: m.marketId,
            oracleAddress: oracle,
            loanAsset,
            collateralAsset,
            loanAssetDecimals: m.loanDecimals,
            collateralAssetDecimals: cp.decimals,
            lltv: "0",
            irm: ZERO,
          },
        });
      }
    }
    if (rows.length) injectedByChain[chainId] = rows;
  }

  return fetchMorphoOracleData(injectedByChain, true);
}
