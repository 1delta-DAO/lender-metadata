import { mergeData } from "../utils.js";
import { classifyEulerOracles } from "./euler/classifyOracles.js";
const eulerClassifiedFile = "./data/euler-oracles-classified.json";
export class EulerOracleDataUpdater {
    name = "Euler Oracle Classification";
    async fetchData() {
        const data = await classifyEulerOracles();
        return { [eulerClassifiedFile]: data };
    }
    mergeData(_oldData, data, _fileKey) {
        return mergeData(data ?? {}, {});
    }
    defaults = {};
}
