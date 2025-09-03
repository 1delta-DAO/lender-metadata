import { fetchCompoundV2TypeTokenData } from "./compound-v2/fetchEverything.js";
const pools = "./config/compound-v2-pools.json";
const tokens = "./data/compound-v2-c-tokens.json";
const reservesPath = "./data/compound-v2-reserves.json";
// Example of another updater (you can add more like this)
export class CompoundV2Updater {
    name = "Compound V2";
    async fetchData() {
        const { cTokens, reserves, COMPOUND_V2_COMPTROLLERS } = await fetchCompoundV2TypeTokenData();
        // Placeholder for another data source
        // This could fetch from another API, parse files, etc.
        return {
            [tokens]: cTokens,
            [reservesPath]: reserves,
            [pools]: COMPOUND_V2_COMPTROLLERS,
        };
    }
    mergeData(oldData, data, fileKey) {
        return data;
    }
    defaults = {};
}
