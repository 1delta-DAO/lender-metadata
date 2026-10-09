import { mergeData } from "../utils.js";
import { classifyEulerOracles } from "./euler/classifyOracles.js";
const eulerClassifiedFile = "./data/euler-oracles-classified.json";
export class EulerOracleDataUpdater {
    name = "Euler Oracle Classification";
    async fetchData() {
        const data = await classifyEulerOracles();
        return { [eulerClassifiedFile]: data };
    }
    mergeData(oldData, data, _fileKey) {
        // A chain whose RPC returned no vaults this run (deprecated chain, dead RPC)
        // keeps its previous block instead of disappearing from the file.
        const out = { ...(data ?? {}) };
        for (const [chainId, block] of Object.entries(oldData ?? {})) {
            const fresh = out[chainId];
            if (!fresh || Object.keys(fresh).length === 0) {
                if (block && Object.keys(block).length > 0)
                    out[chainId] = block;
            }
        }
        return mergeData(out, {});
    }
    defaults = {};
}
