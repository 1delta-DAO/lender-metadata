import { mergeData } from "../utils.js";
import { classifyAaveOracles, classifyAaveV4Oracles, } from "./aave/classifyOracles.js";
const aaveClassifiedFile = "./data/aave-oracles-classified.json";
const aaveV4ClassifiedFile = "./data/aave-v4-oracles-classified.json";
export class AaveOracleDataUpdater {
    name = "Aave Oracle Classification";
    async fetchData() {
        const data = await classifyAaveOracles();
        return { [aaveClassifiedFile]: data };
    }
    mergeData(_oldData, data, _fileKey) {
        return mergeData(data ?? {}, {});
    }
    defaults = {};
}
export class AaveV4OracleDataUpdater {
    name = "Aave V4 Oracle Classification";
    async fetchData() {
        const data = await classifyAaveV4Oracles();
        return { [aaveV4ClassifiedFile]: data };
    }
    mergeData(_oldData, data, _fileKey) {
        return mergeData(data ?? {}, {});
    }
    defaults = {};
}
