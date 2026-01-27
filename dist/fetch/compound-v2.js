import { fetchCompoundV2TypeTokenData } from "./compound-v2/fetchEverything.js";
const pools = "./config/compound-v2-pools.json";
const tokens = "./data/compound-v2-c-tokens.json";
const tokenArray = "./data/compound-v2-tokens.json";
const reservesPath = "./data/compound-v2-reserves.json";
const oraclesPath = "./data/compound-v2-oracles.json";
// Example of another updater (you can add more like this)
export class CompoundV2Updater {
    name = "Compound V2";
    async fetchData() {
        const { cTokens, cTokenArray, reserves, COMPOUND_V2_COMPTROLLERS, oracles } = await fetchCompoundV2TypeTokenData();
        // Placeholder for another data source
        // This could fetch from another API, parse files, etc.
        return {
            [tokenArray]: cTokenArray,
            [tokens]: cTokens,
            [reservesPath]: reserves,
            [oraclesPath]: oracles,
            [pools]: COMPOUND_V2_COMPTROLLERS,
        };
    }
    mergeData(oldData, data, fileKey) {
        return data;
    }
    defaults = {};
}
