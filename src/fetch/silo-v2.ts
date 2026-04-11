import { DataUpdater } from "../types.js";
import { loadExisting, mergeData, sleep } from "../utils.js";
import { DEFAULTS, DEFAULTS_SHORT } from "./defaults.js";
import { fetchSiloV2MarketsFromApi, type ApiMarket } from "./silo-v2/api.js";
import { fetchSiloV2MarketsForChain } from "./silo-v2/fetcher.js";
import { buildSiloLabels } from "./silo-labels.js";
import type {
  SiloMarketsType,
  SiloPeripheralsType,
} from "./silo-v2/types.js";

const peripheralsFile = "./config/silo-v2-peripherals.json";
const marketsFile = "./data/silo-v2-markets.json";
const labelsFile = "./data/lender-labels.json";

/**
 * Silo v2 lender metadata.
 *
 * Pair discovery uses the public Silo frontend API
 * (`https://v2.silo.finance/api/borrow`) — that gives us every active market
 * grouped by `marketId` (== siloConfig) along with each silo's underlying
 * token / decimals / symbol. The slow `SiloFactory.NewSilo` log scan is
 * intentionally NOT used as a fallback.
 *
 * For every market we still call `SiloConfig.getConfig(silo)` on-chain to
 * fill in the static fields the API doesn't expose: share tokens, oracles,
 * IRM, full fee vector, both-side `lt`/`maxLtv`, hook receiver. That data
 * lives in `data/silo-v2-markets.json` and is loaded by `data-sdk` at
 * initializer time so the runtime fetcher only emits the 3 hot-path calls
 * per silo.
 */
export class SiloV2Updater implements DataUpdater {
  name = "Silo V2";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    const peripherals: SiloPeripheralsType = await loadExisting(
      peripheralsFile,
    );

    const apiMarkets = await fetchSiloV2MarketsFromApi();
    const byChain = new Map<string, ApiMarket[]>();
    for (const m of apiMarkets) {
      const list = byChain.get(m.chainId) ?? [];
      list.push(m);
      byChain.set(m.chainId, list);
    }
    console.log(
      `Silo V2: API returned ${apiMarkets.length} unique markets across ${byChain.size} chains`,
    );

    const markets: SiloMarketsType = {};
    const chainIds = [...byChain.keys()];
    for (let i = 0; i < chainIds.length; i++) {
      const chainId = chainIds[i];
      try {
        const list = await fetchSiloV2MarketsForChain(
          chainId,
          byChain.get(chainId)!,
        );
        if (list.length > 0) markets[chainId] = list;
        console.log(
          `Silo V2: chain ${chainId}: ${list.length}/${byChain.get(chainId)!.length} markets resolved`,
        );
      } catch (e) {
        console.log(
          `Silo V2: failed to fetch markets for chain ${chainId}:`,
          e,
        );
      }
      if (i < chainIds.length - 1) await sleep(1000);
    }

    const labels = buildSiloLabels(markets, "V2", "Silo V2", "S2");

    return {
      [peripheralsFile]: peripherals,
      [marketsFile]: markets,
      [labelsFile]: labels,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    if (fileKey === marketsFile) {
      // Markets file is fully regenerated each run — overwrite per chain so
      // a single chain RPC failure doesn't wipe other chains.
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
