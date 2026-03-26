import { mergeData } from "../utils.js";
import { fetchMorphoOracleData } from "./morpho/fetchMorphoOracleData.js";
const oraclesDataFile = "./data/morpho-oracles-data.json";
export class MorphoOracleDataUpdater {
    name = "Morpho Oracle Data";
    async fetchData() {
        const data = await fetchMorphoOracleData();
        return { [oraclesDataFile]: data };
    }
    mergeData(oldData, data, _fileKey) {
        return mergeData(oldData, data);
    }
    defaults = {};
}
