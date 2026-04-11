import { DataUpdater } from "../types.js";
import { loadExisting, mergeData } from "../utils.js";
import { DEFAULTS, DEFAULTS_SHORT } from "./defaults.js";
import {
  fetchAllSilos,
  type GqlMarket,
  type GqlSilo,
} from "./silo-shared/graphql.js";
import { buildSiloLabels } from "./silo-labels.js";
import type {
  SiloHalfStatic,
  SiloMarketEntry,
  SiloMarketsType,
  SiloPeripheralsType,
} from "./silo-v2/types.js";

const peripheralsFile = "./config/silo-v2-peripherals.json";
const marketsFile = "./data/silo-v2-markets.json";
const labelsFile = "./data/lender-labels.json";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * Silo v2 lender metadata.
 *
 * Both discovery and all static config fields come from the Silo v3
 * GraphQL indexer (`https://api-v3.silo.finance`). That indexer serves
 * whitelisted v2 markets alongside v3 — we filter by
 * `protocol.protocolVersion === "v2"` and map into the existing v2
 * on-disk shape so downstream `data-sdk` consumers keep working without
 * changes.
 *
 * Notes:
 * - No on-chain `SiloConfig.getConfig` pass. The indexer exposes every
 *   field the old multicall produced except `callBeforeQuote`, which we
 *   default to `false` (every live v2 market currently has this flag
 *   unset, so it's a no-op migration).
 * - Coverage is larger than the old REST endpoint: the public v2 borrow
 *   API only returned markets with active liquidity, the indexer returns
 *   every whitelisted market.
 */
export class SiloV2Updater implements DataUpdater {
  name = "Silo V2";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    const peripherals: SiloPeripheralsType = await loadExisting(
      peripheralsFile,
    );

    const raw = await fetchAllSilos();
    const markets: SiloMarketsType = {};

    for (const s of raw) {
      if (s.protocol?.protocolVersion !== "v2") continue;
      const entry = toV2Entry(s);
      if (!entry) continue;
      (markets[String(s.chainId)] ??= []).push(entry);
    }

    for (const chain of Object.keys(markets)) {
      markets[chain].sort((a, b) =>
        a.siloConfig.localeCompare(b.siloConfig),
      );
    }

    const chainCounts = Object.entries(markets).map(
      ([c, l]) => `${c}:${l.length}`,
    );
    console.log(
      `Silo V2: fetched ${chainCounts.length} chains from API (${chainCounts.join(", ")})`,
    );

    const labels = buildSiloLabels(markets, "V2", "Silo V2", "S2");

    return {
      [peripheralsFile]: peripherals,
      [marketsFile]: markets,
      [labelsFile]: labels,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    if (fileKey === marketsFile) {
      const merged: SiloMarketsType = { ...(oldData ?? {}) };
      for (const chain of Object.keys(data ?? {})) {
        merged[chain] = (data as SiloMarketsType)[chain];
      }
      return merged;
    }
    if (fileKey === labelsFile) {
      return mergeData(oldData, data, this.defaults[labelsFile]);
    }
    return mergeData(oldData, data);
  }

  defaults: { [file: string]: any } = {
    [labelsFile]: { names: DEFAULTS, shortNames: DEFAULTS_SHORT },
  };
}

function lower(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

function toV2Half(
  m: GqlMarket,
  hookReceiver: string | undefined,
): SiloHalfStatic {
  return {
    silo: lower(m.id),
    token: lower(m.inputToken?.id),
    decimals: m.inputToken?.decimals ?? 0,
    symbol: m.inputToken?.symbol,
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
    hookReceiver,
    // The GraphQL indexer doesn't expose `callBeforeQuote`. Every live v2
    // market currently has it `false`, so defaulting here is lossless.
    callBeforeQuote: false,
  };
}

function toV2Entry(s: GqlSilo): SiloMarketEntry | null {
  if (!s.market1 || !s.market2) return null;
  const hr =
    s.gaugeHookReceiver && lower(s.gaugeHookReceiver) !== ZERO_ADDR
      ? lower(s.gaugeHookReceiver)
      : undefined;
  const byIndex: { [k: number]: SiloHalfStatic } = {};
  byIndex[s.market1.index] = toV2Half(s.market1, hr);
  byIndex[s.market2.index] = toV2Half(s.market2, hr);
  const silo0 = byIndex[0];
  const silo1 = byIndex[1];
  if (!silo0 || !silo1) return null;
  // Preserve the existing on-disk name format: `<sym0>/<sym1>` (slash).
  return {
    siloConfig: lower(s.configAddress),
    name: `${silo0.symbol ?? "?"}/${silo1.symbol ?? "?"}`,
    silo0,
    silo1,
  };
}
