import { mergeData } from "../utils.js";
import { classifyCompoundV2Oracles } from "./compound-v2/classifyOracles.js";
const oraclesClassifiedFile = "./data/compound-v2-oracles-classified.json";
export class CompoundV2OracleDataUpdater {
    name = "Compound V2 Oracle Classification";
    async fetchData() {
        const data = await classifyCompoundV2Oracles();
        return { [oraclesClassifiedFile]: data };
    }
    /** Replace wholesale — keeping stale fork/chain/cToken keys would be misleading. */
    mergeData(_oldData, data, _fileKey) {
        return mergeData(data ?? {}, {});
    }
    defaults = {};
}
