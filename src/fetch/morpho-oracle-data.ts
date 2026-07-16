import { DataUpdater } from "../types.js";
import { mergeData } from "../utils.js";
import { fetchMorphoOracleData } from "./morpho/fetchMorphoOracleData.js";
import type { MorphoOraclesDataMap } from "./morpho/fetchMorphoOracleData.js";

const oraclesDataFile = "./data/morpho-oracles-data.json";

export class MorphoOracleDataUpdater implements DataUpdater {
  name = "Morpho Oracle Data";

  async fetchData(): Promise<Partial<any>> {
    const data = await fetchMorphoOracleData();
    return { [oraclesDataFile]: data };
  }

  /**
   * Market-level union: never lose entries.
   *
   * A freshly fetched market fully overrides its previous entry, and new
   * markets / chains are added — but any market or chain that is ABSENT from
   * this run is retained from the existing file. A transient per-chain or
   * per-fork fetch failure (which surfaces as a missing chain/market rather
   * than a thrown error, see fetchMorphoOracleData) must never wipe
   * previously-good data, so we only override and add, never delete.
   *
   * This is a *market-level* replace, not a field-level deep-merge: a
   * re-fetched market object replaces the old one wholesale, so stale fields
   * inside a re-fetched market never linger. (Field-level deep-merge was
   * avoided for exactly that reason.)
   *
   * Trade-off: a market that has genuinely been removed on-chain will persist
   * until it is re-fetched with fresh data. That is the accepted cost of
   * guaranteeing no entry is ever lost to a partial fetch.
   */
  mergeData(oldData: any, data: any, _fileKey: string): Partial<any> {
    const prev = (oldData ?? {}) as MorphoOraclesDataMap;
    const next = (data ?? {}) as MorphoOraclesDataMap;

    const out: MorphoOraclesDataMap = {};
    const chains = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const chain of chains) {
      const prevChain = prev[chain] ?? {};
      const nextChain = next[chain] ?? {};
      const marketIds = new Set([
        ...Object.keys(prevChain),
        ...Object.keys(nextChain),
      ]);
      const mergedChain: MorphoOraclesDataMap[string] = {};
      for (const id of marketIds) {
        // Fresh entry overrides wholesale; otherwise retain the existing one.
        mergedChain[id] = id in nextChain ? nextChain[id] : prevChain[id];
      }
      out[chain] = mergedChain;
    }

    // Reuse mergeData purely to get stable, sorted key ordering for clean diffs.
    return mergeData(out, {});
  }

  defaults = {};
}
