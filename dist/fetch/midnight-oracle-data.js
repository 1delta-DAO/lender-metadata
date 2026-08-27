import { mergeData } from "../utils.js";
import { fetchMidnightOracleData } from "./midnight/fetchMidnightOracleData.js";
const oraclesDataFile = "./data/midnight-oracles-data.json";
export class MidnightOracleDataUpdater {
    name = "Midnight Oracle Data";
    async fetchData() {
        const data = await fetchMidnightOracleData();
        return { [oraclesDataFile]: data };
    }
    /**
     * Market-level union (never lose entries) — same rationale as the Morpho
     * updater: Midnight markets are Morpho-lineage (immutable, append-only), so a
     * market missing from a run is a fetch gap, never a deletion. A re-fetched market
     * replaces its entry wholesale; absent markets/chains are retained.
     */
    mergeData(oldData, data, _fileKey) {
        const prev = (oldData ?? {});
        const next = (data ?? {});
        const out = {};
        const chains = new Set([...Object.keys(prev), ...Object.keys(next)]);
        for (const chain of chains) {
            const prevChain = prev[chain] ?? {};
            const nextChain = next[chain] ?? {};
            const ids = new Set([...Object.keys(prevChain), ...Object.keys(nextChain)]);
            const merged = {};
            for (const id of ids)
                merged[id] = id in nextChain ? nextChain[id] : prevChain[id];
            out[chain] = merged;
        }
        return mergeData(out, {});
    }
    defaults = {};
}
