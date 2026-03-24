import { mergeData } from "../utils.js";
import { fetchCompoundV3Data } from "./compound-v3/fetchEverything.js";
const pools = "./config/compound-v3-pools.json";
const oracles = "./data/compound-v3-oracles.json";
const oraclesData = "./data/compound-v3-oracles-data.json";
const baseData = "./data/compound-v3-base-data.json";
const reserves = "./data/compound-v3-reserves.json";
// Example of another updater (you can add more like this)
export class CompoundV3Updater {
    name = "Compound V3";
    async fetchData() {
        const { compoundReserves, compoundBaseData, COMETS_PER_CHAIN_MAP, cometOracles, cometOraclesData, } = await fetchCompoundV3Data();
        return {
            [baseData]: compoundBaseData,
            [reserves]: compoundReserves,
            [oracles]: cometOracles,
            [oraclesData]: cometOraclesData,
            [pools]: COMETS_PER_CHAIN_MAP,
        };
    }
    mergeData(oldData, data, fileKey) {
        return mergeData(oldData, data);
    }
    defaults = {};
}
