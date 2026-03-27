import { mergeData } from "../utils.js";
import { fetchMorphoOracleData } from "./morpho/fetchMorphoOracleData.js";
const oraclesDataFile = "./data/morpho-oracles-data.json";
export class MorphoOracleDataUpdater {
    name = "Morpho Oracle Data";
    async fetchData() {
        const data = await fetchMorphoOracleData();
        return { [oraclesDataFile]: data };
    }
    /**
     * Do not deep-merge with old files (would keep legacy oracle-address keys or removed chains).
     */
    mergeData(_oldData, data, _fileKey) {
        return mergeData(data ?? {}, {});
    }
    defaults = {};
}
