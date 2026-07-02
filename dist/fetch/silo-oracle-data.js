import { mergeData } from "../utils.js";
import { classifySiloOracles } from "./silo/classifyOracles.js";
const siloClassifiedFile = "./data/silo-oracles-classified.json";
export class SiloOracleDataUpdater {
    name = "Silo Oracle Classification";
    async fetchData() {
        const data = await classifySiloOracles();
        return { [siloClassifiedFile]: data };
    }
    mergeData(_oldData, data, _fileKey) {
        return mergeData(data ?? {}, {});
    }
    defaults = {};
}
