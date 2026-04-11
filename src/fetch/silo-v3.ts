import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { DEFAULTS, DEFAULTS_SHORT } from "./defaults.js";
import { fetchSiloV3MarketsFromApi } from "./silo-v3/api.js";
import { fetchSiloV3Peripherals } from "./silo-v3/peripherals.js";
import { buildSiloLabels } from "./silo-labels.js";
import type {
  SiloV3MarketsType,
  SiloV3PeripheralsType,
} from "./silo-v3/types.js";

const peripheralsFile = "./config/silo-v3-peripherals.json";
const marketsFile = "./data/silo-v3-markets.json";
const labelsFile = "./data/lender-labels.json";

/**
 * Silo v3 lender metadata.
 *
 * Unlike v2, pair discovery + all static per-market fields come from a
 * single GraphQL call against `https://api-v3.silo.finance`. That API
 * exposes every field the v2 on-chain `SiloConfig.getConfig` pass
 * produces, so there is no multicall stage here.
 *
 * Peripherals (factory, lens, router, leverage router, vault factory, …)
 * are pulled from the official `silo-finance/silo-contracts-v3` repo
 * deployments dirs; see `./silo-v3/peripherals.ts`.
 */
export class SiloV3Updater implements DataUpdater {
  name = "Silo V3";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    const [markets, peripherals] = await Promise.all([
      fetchSiloV3MarketsFromApi(),
      fetchSiloV3Peripherals(),
    ]);

    const chainCounts = Object.entries(markets).map(
      ([c, list]) => `${c}:${list.length}`,
    );
    console.log(
      `Silo V3: fetched ${chainCounts.length} chains from API (${chainCounts.join(", ")})`,
    );
    console.log(
      `Silo V3: fetched peripherals for ${Object.keys(peripherals).length} chains`,
    );

    const labels = buildSiloLabels(markets, "V3", "Silo V3", "S3");

    return {
      [peripheralsFile]: peripherals,
      [marketsFile]: markets,
      [labelsFile]: labels,
    };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    if (fileKey === marketsFile) {
      // Fully regenerated per chain each run — overwrite one chain at a
      // time so a partial fetch doesn't wipe unrelated chains.
      const merged: SiloV3MarketsType = { ...(oldData ?? {}) };
      for (const chain of Object.keys(data ?? {})) {
        merged[chain] = (data as SiloV3MarketsType)[chain];
      }
      return merged;
    }
    if (fileKey === peripheralsFile) {
      // Peripherals are one entry per chain — merge per chain so a failed
      // fetch for one chain doesn't drop others. Within a chain, later
      // values win (deployments repo is authoritative).
      const merged: SiloV3PeripheralsType = { ...(oldData ?? {}) };
      for (const chain of Object.keys(data ?? {})) {
        merged[chain] = {
          ...(merged[chain] ?? {}),
          ...(data as SiloV3PeripheralsType)[chain],
        };
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
