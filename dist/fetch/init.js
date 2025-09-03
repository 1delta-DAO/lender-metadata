import { fetchInitData } from "./init/fetchEverything.js";
const config = "./data/init-config.json";
const pools = "./config/init-pools.json";
// Example of another updater (you can add more like this)
export class InitUpdater {
    name = "Init";
    async fetchData() {
        const { initDataMap, INIT_CONFIG_PER_CHAIN_MAP } = await fetchInitData();
        // Placeholder for another data source
        // This could fetch from another API, parse files, etc.
        return {
            [config]: initDataMap,
            [pools]: INIT_CONFIG_PER_CHAIN_MAP,
        };
    }
    mergeData(oldData, data, fileKey) {
        return data;
    }
    defaults = {};
}
