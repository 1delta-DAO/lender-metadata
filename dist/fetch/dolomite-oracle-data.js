import { mergeData } from "../utils.js";
import { classifyDolomiteOracles } from "./dolomite/classifyOracles.js";
const oraclesClassifiedFile = "./data/dolomite-oracles-classified.json";
export class DolomiteOracleDataUpdater {
    name = "Dolomite Oracle Classification";
    async fetchData() {
        const data = await classifyDolomiteOracles();
        return { [oraclesClassifiedFile]: data };
    }
    /** Replace wholesale — keeping stale chain/marketId keys would be misleading. */
    mergeData(_oldData, data, _fileKey) {
        return mergeData(data ?? {}, {});
    }
    defaults = {};
}
