import { mergeData } from "../utils.js";
import { classifyExactlyOracles } from "./exactly/classifyOracles.js";
const oraclesClassifiedFile = "./data/exactly-oracles-classified.json";
export class ExactlyOracleDataUpdater {
    name = "Exactly Oracle Classification";
    async fetchData() {
        const data = await classifyExactlyOracles();
        return { [oraclesClassifiedFile]: data };
    }
    /** Replace wholesale — keeping stale chain/market keys would be misleading. */
    mergeData(_oldData, data, _fileKey) {
        return mergeData(data ?? {}, {});
    }
    defaults = {};
}
