// Silo v3 market fetcher — thin wrapper around the shared GraphQL client
// in `../silo-shared/graphql.ts`. The indexer serves both v2 and v3 silos,
// so we filter on `protocol.protocolVersion === "v3"` here and map into the
// v3 on-disk shape.

import {
  fetchAllSilos,
  type GqlMarket,
  type GqlSilo,
} from "../silo-shared/graphql.js";
import type {
  SiloV3HalfStatic,
  SiloV3MarketEntry,
  SiloV3MarketsType,
} from "./types.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function lower(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

function toHalf(m: GqlMarket): SiloV3HalfStatic {
  return {
    silo: lower(m.id),
    token: lower(m.inputToken?.id),
    decimals: m.inputToken?.decimals ?? 0,
    symbol: m.inputToken?.symbol,
    index: m.index,
    protectedShareToken: lower(m.spTokenId),
    collateralShareToken: lower(m.sTokenId),
    debtShareToken: lower(m.dTokenId),
    solvencyOracle: lower(m.solvencyOracleAddress),
    maxLtvOracle: lower(m.maxLtvOracleAddress),
    interestRateModel: lower(m.interestRateModelId),
    maxLtv: m.maxLtv,
    lt: m.lt,
    liquidationTargetLtv: m.liquidationTargetLtv,
    liquidationFee: m.liquidationFee,
    flashloanFee: m.flashLoanFee,
    daoFee: m.daoFee,
    deployerFee: m.deployerFee,
    keeperFee: m.keeperFee ?? undefined,
  };
}

function toEntry(s: GqlSilo): SiloV3MarketEntry | null {
  if (!s.market1 || !s.market2) return null;
  const byIndex: { [k: number]: SiloV3HalfStatic } = {};
  byIndex[s.market1.index] = toHalf(s.market1);
  byIndex[s.market2.index] = toHalf(s.market2);
  const silo0 = byIndex[0];
  const silo1 = byIndex[1];
  if (!silo0 || !silo1) return null;
  return {
    siloConfig: lower(s.configAddress),
    name: s.name ?? `${silo0.symbol ?? "?"}/${silo1.symbol ?? "?"}`,
    hookReceiver:
      s.gaugeHookReceiver && lower(s.gaugeHookReceiver) !== ZERO_ADDR
        ? lower(s.gaugeHookReceiver)
        : undefined,
    silo0,
    silo1,
  };
}

/**
 * Group + map a raw `GqlSilo[]` into the v3 on-disk shape, filtering on
 * `protocol.protocolVersion === "v3"`. Pairs are sorted by `siloConfig`
 * within each chain so output diffs are stable across runs.
 */
export function buildV3MarketsFromRaw(raw: GqlSilo[]): SiloV3MarketsType {
  const out: SiloV3MarketsType = {};

  for (const s of raw) {
    if (s.protocol?.protocolVersion !== "v3") continue;
    const entry = toEntry(s);
    if (!entry) continue;
    (out[String(s.chainId)] ??= []).push(entry);
  }

  for (const chain of Object.keys(out)) {
    out[chain].sort((a, b) => a.siloConfig.localeCompare(b.siloConfig));
  }

  return out;
}

/**
 * Fetch every Silo v3 lending pair from the GraphQL API, grouped by
 * chainId.
 */
export async function fetchSiloV3MarketsFromApi(): Promise<SiloV3MarketsType> {
  return buildV3MarketsFromRaw(await fetchAllSilos());
}
