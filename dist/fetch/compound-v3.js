import { COMETS_PER_CHAIN_MAP } from "@1delta/asset-registry";
import { fetchCompoundV3Data } from "./compound-v3/fetchEverything.js";
const pools = "./data/compound-v3-pools.json";
const baseData = "./data/compound-v3-base-data.json";
const reserves = "./data/compound-v3-reserves.json";
// Example of another updater (you can add more like this)
export class CompoundV3Updater {
    name = "Compound V3";
    async fetchData() {
        const { compoundReserves, compoundBaseData } = await fetchCompoundV3Data();
        // Placeholder for another data source
        // This could fetch from another API, parse files, etc.
        return {
            [baseData]: compoundBaseData,
            [reserves]: compoundReserves,
            [pools]: COMETS_PER_CHAIN_MAP,
        };
    }
    mergeData(oldData, data, fileKey) {
        return data;
    }
    defaults = {};
}
