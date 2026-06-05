import { DataUpdater } from "../types.js";
import { mergeData, sleep } from "../utils.js";
import { DOLOMITE_DEPLOYMENTS } from "./dolomite/constants.js";
import { fetchDolomiteMarkets } from "./dolomite/fetcher.js";

const configFile = "./config/dolomite-margin.json";

/**
 * Dolomite is a single global cross-margin pool (DolomiteMargin core) per chain.
 * The data-sdk config is `{ chainId: { dolomiteMargin, expiry, markets } }` where
 * `markets` is the governance-assigned marketId → token map, read on-chain. The
 * margin/expiry addresses are static (deployed.json); only `markets` grows, so a
 * plain deep-merge keeps the file stable and append-only.
 */
export class DolomiteUpdater implements DataUpdater {
  name = "Dolomite";

  async fetchData(): Promise<{ [file: string]: Partial<any> }> {
    const out: Record<string, any> = {};

    const chains = Object.entries(DOLOMITE_DEPLOYMENTS);
    for (let i = 0; i < chains.length; i++) {
      const [chainId, addrs] = chains[i];
      let markets: Record<string, string> = {};
      try {
        markets = await fetchDolomiteMarkets(chainId, addrs.dolomiteMargin);
        console.log(
          `Dolomite: chain ${chainId}: ${Object.keys(markets).length} markets`,
        );
      } catch (e) {
        console.log(
          `Dolomite: failed to fetch markets for chain ${chainId}:`,
          (e as any)?.shortMessage ?? (e as any)?.message ?? e,
        );
      }
      out[chainId] = { ...addrs, markets };

      if (i < chains.length - 1) await sleep(500);
    }

    return { [configFile]: out };
  }

  mergeData(oldData: any, data: any, fileKey: string): Partial<any> {
    return mergeData(oldData, data);
  }

  defaults = {};
}
