import { createPublicClient, http } from "viem";
import { multicallRetryUniversal } from "@1delta/providers";
import {
  dolomiteRiskOverrideSetterAbi,
  DOLOMITE_CATEGORIES,
  DOLOMITE_RISK_FEATURES,
  DOLOMITE_SUBGRAPH_URLS,
  DOLOMITE_FALLBACK_RPCS,
} from "./constants.js";

const ZERO = "0x0000000000000000000000000000000000000000";

export interface DolomiteCategoryParam {
  marginRatioOverride: number;
  liquidationRewardOverride: number;
}
export interface DolomiteSingleCollateral {
  debtMarketIds: string[];
  marginRatioOverride: number;
  liquidationRewardOverride: number;
}
export interface DolomiteEmodeChain {
  /** The DolomiteAccountRiskOverrideSetter address (a.k.a. e-mode setter). */
  setter: string;
  /** category name → override params (only categories with a non-zero ratio). */
  categories: Record<string, DolomiteCategoryParam>;
  /** marketId → category name (only markets in a non-NONE category). */
  marketCategories: Record<string, string>;
  /** marketId → risk feature (only markets with a non-NONE feature). */
  riskFeatures: Record<
    string,
    { feature: string; singleCollateral?: DolomiteSingleCollateral[] }
  >;
}

const dec = (v: any): number => Number(BigInt(v?.value ?? v ?? 0)) / 1e18;

/**
 * Discover the per-chain e-mode setter from the subgraph. Returns null when the
 * chain has no subgraph or no setter configured (e.g. legacy Arbitrum), which
 * means e-mode is not active there.
 */
export async function getDolomiteSetter(
  chainId: string,
): Promise<string | null> {
  const url = DOLOMITE_SUBGRAPH_URLS[chainId];
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "{ dolomiteMargins(first:1){ defaultAccountRiskOverrideSetter } }",
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const setter =
      json?.data?.dolomiteMargins?.[0]?.defaultAccountRiskOverrideSetter;
    if (!setter || setter.toLowerCase() === ZERO) return null;
    return setter.toLowerCase();
  } catch {
    return null;
  }
}

// multicall with a direct-RPC fallback for chains outside @1delta/providers.
async function readSetter(
  chainId: string,
  setter: string,
  calls: { name: string; args: any[] }[],
): Promise<any[]> {
  const full = calls.map((c) => ({ address: setter, name: c.name, args: c.args }));
  try {
    return (await multicallRetryUniversal({
      chain: chainId,
      calls: full as any,
      abi: dolomiteRiskOverrideSetterAbi,
      allowFailure: true,
    })) as any[];
  } catch (e) {
    const rpc = DOLOMITE_FALLBACK_RPCS[chainId];
    if (!rpc) throw e;
    const client = createPublicClient({ transport: http(rpc) });
    return Promise.all(
      full.map((c) =>
        client
          .readContract({
            address: setter as `0x${string}`,
            abi: dolomiteRiskOverrideSetterAbi,
            functionName: c.name as any,
            args: c.args as any,
          })
          .catch(() => null),
      ),
    );
  }
}

/**
 * Reads the full e-mode config for a chain from its risk-override setter:
 * per-category override ratios, market → category membership, and per-market
 * risk features (incl. single-collateral allow-lists). `marketIds` is the same
 * id list used for the markets map.
 */
export async function fetchDolomiteEmode(
  chainId: string,
  setter: string,
  marketIds: string[],
): Promise<DolomiteEmodeChain> {
  // 1. category params for BERA/BTC/ETH/STABLE (skip NONE=0)
  const catParams = await readSetter(
    chainId,
    setter,
    [1, 2, 3, 4].map((c) => ({ name: "getCategoryParamByCategory", args: [c] })),
  );
  const categories: Record<string, DolomiteCategoryParam> = {};
  catParams.forEach((p, i) => {
    if (!p) return;
    const name = DOLOMITE_CATEGORIES[i + 1];
    const marginRatioOverride = dec(p.marginRatioOverride);
    if (marginRatioOverride > 0) {
      categories[name] = {
        marginRatioOverride,
        liquidationRewardOverride: dec(p.liquidationRewardOverride),
      };
    }
  });

  // 2. market → category and 3. market → risk feature
  const catByMarket = await readSetter(
    chainId,
    setter,
    marketIds.map((m) => ({ name: "getCategoryByMarketId", args: [BigInt(m)] })),
  );
  const featByMarket = await readSetter(
    chainId,
    setter,
    marketIds.map((m) => ({ name: "getRiskFeatureByMarketId", args: [BigInt(m)] })),
  );

  const marketCategories: Record<string, string> = {};
  const riskFeatures: DolomiteEmodeChain["riskFeatures"] = {};
  const singleCollateralMarkets: string[] = [];

  marketIds.forEach((m, i) => {
    const cat = Number(catByMarket[i] ?? 0);
    if (cat > 0) marketCategories[m] = DOLOMITE_CATEGORIES[cat];
    const feat = Number(featByMarket[i] ?? 0);
    if (feat > 0) {
      riskFeatures[m] = { feature: DOLOMITE_RISK_FEATURES[feat] };
      if (DOLOMITE_RISK_FEATURES[feat] === "SINGLE_COLLATERAL_WITH_STRICT_DEBT") {
        singleCollateralMarkets.push(m);
      }
    }
  });

  // 4. single-collateral allow-lists (only for SINGLE_COLLATERAL markets)
  if (singleCollateralMarkets.length > 0) {
    const scParams = await readSetter(
      chainId,
      setter,
      singleCollateralMarkets.map((m) => ({
        name: "getRiskFeatureForSingleCollateralByMarketId",
        args: [BigInt(m)],
      })),
    );
    singleCollateralMarkets.forEach((m, i) => {
      const arr = scParams[i];
      if (Array.isArray(arr)) {
        riskFeatures[m].singleCollateral = arr.map((s: any) => ({
          debtMarketIds: (s.debtMarketIds ?? []).map((d: any) => d.toString()),
          marginRatioOverride: dec(s.marginRatioOverride),
          liquidationRewardOverride: dec(s.liquidationRewardOverride),
        }));
      }
    });
  }

  return { setter, categories, marketCategories, riskFeatures };
}
