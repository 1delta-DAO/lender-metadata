import { fetchAaveTypePriceOracles } from "./aave/fetchOracles.js";
import { fetchAaveTypeTokenData } from "./aave/fetchReserves.js";
const tokensFile = "./data/aave-tokens.json";
const pools = "./config/aave-pools.json";
const oraclesFile = "./data/aave-oracles.json";
const aaveAddresses = "./data/aave-reserves.json";
// Example of another updater (you can add more like this)
export class AaveUpdater {
    name = "Aave";
    async fetchData() {
        const { reserves, tokens, AAVE_FORK_POOL_DATA } = await fetchAaveTypeTokenData();
        const oracles = await fetchAaveTypePriceOracles(AAVE_FORK_POOL_DATA);
        // Placeholder for another data source
        // This could fetch from another API, parse files, etc.
        return {
            [aaveAddresses]: reserves,
            [tokensFile]: tokens,
            [oraclesFile]: oracles,
            [pools]: AAVE_FORK_POOL_DATA,
        };
    }
    mergeData(oldData, data, fileKey) {
        return data;
    }
    defaults = {};
}
