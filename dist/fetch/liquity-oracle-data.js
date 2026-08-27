import { mergeData } from "../utils.js";
import { classifyLiquityOracles } from "./liquity/classifyOracles.js";
const oraclesClassifiedFile = "./data/liquity-oracles-classified.json";
export class LiquityOracleDataUpdater {
    name = "Liquity Oracle Classification";
    async fetchData() {
        const data = await classifyLiquityOracles();
        return { [oraclesClassifiedFile]: data };
    }
    /** Replace wholesale — keeping stale chain/branch keys would be misleading. */
    mergeData(_oldData, data, _fileKey) {
        return mergeData(data ?? {}, {});
    }
    defaults = {};
}
